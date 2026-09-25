import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { mayReadBatches } from '@/modules/wms/batches/read-door';
import { seesAllMoney } from '@/modules/wms/finance/scope';
import { cargoRiskList, type RiskKind, type RiskRow } from '@/modules/wms/reports/business';
import { PageHeader } from '@/components/ui/page';
import { m3, usd } from '@/components/charts/format';

export const dynamic = 'force-dynamic';

/**
 * «Yuk xavfi» — the cartons whose money is wrong or gone, by name, so the
 * dashboard's «e'tibor kerak» rows are never a dead end (owner 6a: the loss
 * is shown, the money stays where it is).
 *
 * The four lists are `cargoAtRisk`'s own rows (`cargoRiskList`, the same SQL
 * fragments), so a count on the dashboard is the length of a list here. The
 * dollar column is the landed cost already spent carrying each carton — not
 * the goods' value and not a compensation figure — and only money readers see
 * it (round 91's rule).
 */
export default async function CargoRiskPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const allWh = actor.permissions.has('reports.all_warehouses');
  const ownWh = actor.permissions.has('reports.own_warehouse');
  if ((!allWh && !ownWh) || !mayReadBatches(actor.permissions)) redirect('/reports');
  const t = await getTranslations('reports');
  const money = actor.permissions.has('finance.reports') && seesAllMoney(actor);
  // The two scope rules the lists' destinations use, intersected: a scoped
  // actor with no warehouse reads nothing (the query functions read an empty
  // list as «no filter», which would be the whole company).
  const scoped = !allWh || actor.warehouseScoped;
  const scope = scoped ? actor.warehouseIds : undefined;
  const blind = scoped && actor.warehouseIds.length === 0;

  const kinds: { kind: RiskKind; title: string; hint?: string }[] = [
    { kind: 'missing', title: t('riskMissing') },
    { kind: 'phantom', title: t('riskPhantom'), hint: t('riskPhantomHint') },
    { kind: 'lost', title: t('riskLost') },
    { kind: 'undocumented', title: t('riskUndocumented') },
  ];
  const lists = blind
    ? kinds.map(() => [] as RiskRow[])
    : await Promise.all(kinds.map((k) => cargoRiskList(k.kind, scope)));

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <PageHeader icon="alert" title={t('cargoRisk')} />
      {kinds.map((k, i) => {
        const rows = lists[i] ?? [];
        return (
          <section key={k.kind} id={k.kind} className="space-y-2" data-testid={`risk-${k.kind}`}>
            <p className="section-title">
              {k.title} <span className="text-ink-500">({rows.length})</span>
            </p>
            {k.hint && <p className="text-xs text-ink-500">{k.hint}</p>}
            <div className="card !p-0">
              {rows.length === 0 ? (
                <p className="p-3 text-sm text-ink-500">{t('riskEmpty')}</p>
              ) : (
                <ul className="divide-y divide-line">
                  {rows.map((row) => (
                    <li key={`${row.boxId}-${row.batchId ?? ''}`} className="p-3 text-sm">
                      <div className="flex items-baseline gap-2">
                        <Link href={`/boxes/${row.boxId}`} className="font-mono font-bold text-brand-700">
                          {row.shortCode}
                        </Link>
                        <span className="min-w-0 flex-1 truncate font-mono text-ink-700">
                          {row.clientCode ?? row.marking ?? '—'}
                        </span>
                        {money && (
                          <span className="whitespace-nowrap font-mono tabular-nums" title={t('riskCost')}>
                            {usd(row.usd)}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-baseline gap-2 text-xs text-ink-500">
                        {row.batchId && row.batchCode ? (
                          <Link href={`/batches/${row.batchId}`} className="font-mono text-brand-700">
                            {row.batchCode}
                          </Link>
                        ) : null}
                        <span className="ml-auto whitespace-nowrap font-mono">{m3(row.m3)} m³</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {k.kind === 'missing' && rows.length > 0 && (
              <Link href="/transit" className="text-xs font-semibold text-brand-700">
                /transit →
              </Link>
            )}
          </section>
        );
      })}
    </div>
  );
}
