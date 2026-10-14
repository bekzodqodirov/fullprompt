import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { payerView } from '@/modules/wms/partners/staff';
import { getActor } from '@/modules/platform/rbac/authorize';
import { companyMoneySight } from '@/modules/wms/finance/scope';
import { batchCostSheet } from '@/modules/wms/costing/service';
import { explainFreightBills } from '@/modules/wms/costing/freight-offer';
import { costSightFor, tillView } from '@/modules/wms/costing/cost-sight';
import { mayPickTill } from '@/modules/wms/accounting/till-door';
import { mayEnterBatchCost } from '@/modules/wms/costing/cost-door';
import {
  batchForCostEntry,
  costPanelOptions,
  myCostsToday,
  trucksForCostEntry,
} from '@/modules/wms/costing/cost-entry';
import { batchTabHref, mayOpenBatchCard } from '@/modules/wms/batches/card-door';
import { addDays, tashkentDay, tashkentMonthStart } from '@/modules/platform/time/tashkent';
import { PageHeader } from '@/components/ui/page';
import { CostEntryDesk } from './desk';

/**
 * «Partiyaga xarajat» from the general money page (docs/SARFLAR.md §2, his
 * «partiyalarga bolayotgan rasxodni obshiy joydan ham kirgazish»): pick a
 * truck, write its bill, pick the next. The door is the map's AND the truck
 * bill's own grant — `companyMoneySight` with `costs.enter_batch`; the save
 * is the truck card's own `addCostEntryAction`, so nothing about the money
 * path differs (the twin warning included). No `<Suspense>` (#1242).
 */
export default async function SarflarEntryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; p?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const sight = companyMoneySight(actor);
  if (!sight) redirect('/');
  if (!actor.permissions.has('costs.enter_batch')) redirect('/accounting/sarflar');
  const t = await getTranslations('sarflar');
  const params = await searchParams;
  const q = (params.q ?? '').slice(0, 60);
  const today = tashkentDay();
  const monthStart = tashkentMonthStart();
  const previousMonth = addDays(monthStart, -1).slice(0, 7);
  // A bill dated outside «Bu oy» opens its OWN whole month on the map (§8.5).
  const monthHref = (day: string) => {
    const first = `${day.slice(0, 7)}-01`;
    const last = addDays(`${addDays(first, 32).slice(0, 7)}-01`, -1);
    return `/accounting/sarflar?from=${first}&to=${last}`;
  };

  const [picker, chosen, mine] = await Promise.all([
    trucksForCostEntry(actor, q),
    batchForCostEntry(actor, params.p),
    myCostsToday(actor.id, today),
  ]);

  let panel = null;
  let head: { id: string; code: string; card: boolean } | null = null;
  if (chosen.kind === 'ok') {
    const mayEnter = mayEnterBatchCost(actor, chosen.batch);
    const [options, sheet] = await Promise.all([
      costPanelOptions(actor, chosen.batch.id, { mayEnter }),
      batchCostSheet(chosen.batch.id, costSightFor(actor)),
    ]);
    head = { id: chosen.batch.id, code: chosen.batch.code, card: mayOpenBatchCard(actor, chosen.batch) };
    const freightRows = await explainFreightBills(
      sheet.entries.map(({ entry, hasShare }) => ({ ...entry, hasShare })),
      actor,
    );
    panel = {
      targetId: chosen.batch.id,
      entries: sheet.entries.map(({ entry, typeName, clientCode, partnerName, partnerIsStaff, accountName }) => ({
        id: entry.id,
        typeName,
        amount: entry.amount,
        currency: entry.currency,
        amountUsd: entry.amountUsd,
        costDate: entry.costDate,
        allocationBasis: entry.allocationBasis,
        note: entry.note,
        clientCode,
        freight: freightRows.get(entry.id) ?? null,
        rebasable: entry.scope === 'batch',
        ...payerView(actor.permissions, { partnerName, partnerIsStaff }),
        ...tillView(actor.permissions, { accountId: entry.accountId, accountName, mergedExpenseId: entry.mergedExpenseId }),
      })),
      costTypes: options.types,
      currencies: options.currencies,
      clientOptions: options.clients,
      defaultCurrency: options.currencies.includes('CNY') ? 'CNY' : 'USD',
      defaultTypeCode: 'freight',
      canVoid: actor.permissions.has('costs.enter_batch'),
      canAdd: mayEnter,
      today,
      canUnmerge: mayPickTill(actor.permissions),
      tillOptions: options.tills,
      partnerOptions: options.partners,
      freight: options.freight,
    };
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        icon="wallet"
        title={t('entryTitle')}
        subtitle={t('entrySubtitle')}
        back={{ href: '/accounting/sarflar', label: t('title') }}
      />
      {chosen.kind === 'not_found' && (
        <p role="alert" className="card text-sm font-semibold text-bad" data-testid="entry-not-found">
          {t('truckNotFound')}
        </p>
      )}
      {chosen.kind === 'cancelled' && (
        <p role="alert" className="card text-sm font-semibold text-bad" data-testid="entry-cancelled">
          {t('truckCancelled', { code: chosen.code })}
        </p>
      )}
      {head && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-testid="entry-head">
          <h2 className="font-mono text-lg font-bold">{head.code}</h2>
          {head.card && (
            <>
              <Link href={`/batches/${head.id}`} className="text-sm underline">
                {t('openCard')} →
              </Link>
              <Link href={batchTabHref(head.id, 'xarajat')} className="text-sm underline">
                {t('openGrid')} →
              </Link>
            </>
          )}
        </div>
      )}
      <CostEntryDesk
        q={q}
        trucks={picker.rows}
        total={picker.total}
        chosenId={chosen.kind === 'ok' ? chosen.batch.id : null}
        panel={panel}
      />
      {mine.length > 0 && (
        <section className="card space-y-1" data-testid="entry-today">
          <h2 className="text-sm font-bold uppercase text-ink-500">{t('todayMine')}</h2>
          <ul className="divide-y divide-line text-sm">
            {mine.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-x-2 py-1.5 [overflow-wrap:anywhere]">
                <span className="font-mono">{row.batchCode ?? '—'}</span>
                <span>{row.typeName}</span>
                <span className="ml-auto font-mono tabular-nums">
                  {row.amount} {row.currency}
                </span>
                <span className="text-xs text-ink-500">{row.costDate}</span>
                {/* A bill dated outside «Bu oy» is not on the map's default
                    view — say where it is, or it reads as lost. */}
                {(row.costDate > today || row.costDate < monthStart) && (
                  <Link href={monthHref(row.costDate)} className="text-xs text-warn underline">
                    {row.costDate > today
                      ? t('tomorrowDated')
                      : row.costDate.slice(0, 7) === previousMonth
                        ? t('preset.otgan')
                        : t('outOfPeriod', { month: row.costDate.slice(0, 7) })}{' '}
                    →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
