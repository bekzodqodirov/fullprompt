import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { managedClients } from '@/modules/wms/finance/client-cargo';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';

/**
 * "My clients" (owner: "mening mijozlarim — har birining yuki qayerda, m³,
 * kg, pul").
 *
 * A sales manager's own book by default, everyone's for whoever may see all
 * clients — the same scoping rule the CRM funnel uses, so a manager is never
 * shown a client they are not supposed to ring.
 */
export default async function MyClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; filter?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.leads') && !actor.permissions.has('clients.manage')) redirect('/');
  const t = await getTranslations('cargo');
  const tf = await getTranslations('finance');
  const params = await searchParams;

  const seesAll = actor.permissions.has('crm.leads.view_all') || actor.permissions.has('clients.manage');
  const all = seesAll && params.scope === 'all';
  const rows = await managedClients(all ? undefined : actor.id);
  const today = new Date().toISOString().slice(0, 10);

  const withCargo = rows.filter((row) => row.boxCount > 0);
  const withDebt = rows.filter((row) => row.balanceUsd > 0.009);
  const shown =
    params.filter === 'cargo' ? withCargo : params.filter === 'debt' ? withDebt : rows;

  const tab = (filter: string | undefined, label: string, count: number) => {
    const active = (params.filter ?? '') === (filter ?? '');
    const query = new URLSearchParams();
    if (all) query.set('scope', 'all');
    if (filter) query.set('filter', filter);
    const href = `/my-clients${query.size ? `?${query}` : ''}`;
    return (
      <Link key={label} href={href} className={active ? 'chip-brand' : 'chip-neutral'}>
        {label} <b>{count}</b>
      </Link>
    );
  };

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-4xl">
      <PageHeader icon="users" title={all ? t('allClients') : t('myClients')} />
      <p className="text-sm text-ink-500">{t('myClientsHint')}</p>

      <div className="grid grid-cols-3 gap-2.5">
        <Stat label={t('withCargo')} value={withCargo.length} tone="brand" />
        <Stat
          label={t('withDebt')}
          value={withDebt.length}
          tone={withDebt.length ? 'warn' : 'neutral'}
        />
        <Stat
          label={tf('totalDebt')}
          value={`$${Math.round(withDebt.reduce((a, r) => a + r.balanceUsd, 0))}`}
          tone={withDebt.length ? 'bad' : 'good'}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {tab(undefined, t('allClients'), rows.length)}
        {tab('cargo', t('withCargo'), withCargo.length)}
        {tab('debt', t('withDebt'), withDebt.length)}
        {/* Only for someone allowed to see everyone: a sales manager toggling
            this would just get their own list back. */}
        {seesAll && (
          <Link
            href={all ? '/my-clients' : '/my-clients?scope=all'}
            className="chip-neutral ml-auto"
          >
            {all ? t('myClients') : t('allClients')} ⇄
          </Link>
        )}
      </div>

      {shown.length === 0 ? (
        <EmptyState icon="users" title={t('noClients')} />
      ) : (
        <div className="space-y-2">
          {shown.map((row) => (
            <Link
              key={row.clientId}
              href={`/admin/clients/${row.clientId}`}
              data-testid="my-client-row"
              className="card-tap block"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono font-extrabold text-brand-700">{row.clientCode}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink-700">{row.name}</span>
                <span
                  className={`num whitespace-nowrap font-bold ${
                    row.balanceUsd > 0.009 ? 'text-bad' : row.balanceUsd < -0.009 ? 'text-good' : 'text-ink-400'
                  }`}
                >
                  ${row.balanceUsd.toFixed(2)}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-baseline gap-2 text-xs text-ink-500">
                {row.boxCount > 0 ? (
                  <span className="num">
                    {row.boxCount} 📦 · {row.kg} kg · {row.m3} m³
                  </span>
                ) : (
                  <span>{t('noCargo')}</span>
                )}
                {row.lastReceiptAt && (
                  <span>
                    {t('lastReceipt')} {row.lastReceiptAt}
                  </span>
                )}
                {row.nextActionAt && (
                  <span
                    className={`ml-auto font-semibold ${
                      row.nextActionAt <= today ? 'text-warn' : 'text-ink-500'
                    }`}
                  >
                    📞 {row.nextActionAt}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
