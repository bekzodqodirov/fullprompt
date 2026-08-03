import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader } from '@/components/ui/page';

/** Reports hub (§13) — owner's priority order: landed cost, stock/aging, batches. */
export default async function ReportsPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const allWh = actor.permissions.has('reports.all_warehouses');
  const ownWh = actor.permissions.has('reports.own_warehouse');
  if (!allWh && !ownWh) redirect('/');
  const t = await getTranslations('reports');

  const tiles = [
    ...(allWh ? [{ href: '/reports/landed-cost', icon: '💰', label: t('landedCost') }] : []),
    { href: '/reports/stock-aging', icon: '🕰', label: t('stockAging') },
    { href: '/reports/batches', icon: '🚛', label: t('batchRegister') },
    { href: '/reports/receipts-journal', icon: '📥', label: t('receiptsJournal') },
    { href: '/reports/unclaimed', icon: '❓', label: t('unclaimedReport') },
    ...(allWh
      ? [
          { href: '/reports/client-history', icon: '📜', label: t('clientHistory') },
          { href: '/reports/staff-activity', icon: '👥', label: t('staffActivity') },
          // Round 47, item 12: who is buried, whose deadlines slipped, and
          // whether today closed more than it opened.
          { href: '/reports/vazifalar', icon: '✅', label: t('taskAnalytics') },
          { href: '/reports/label-prints', icon: '🖨', label: t('labelPrints') },
        ]
      : []),
    { href: '/transit', icon: '🧭', label: t('transit') },
    { href: '/dashboard', icon: '📊', label: t('dashboard') },
  ];

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <PageHeader icon="report" title={t('title')} />
      <div className="grid grid-cols-2 gap-3">
        {tiles.map((tile) => (
          <Link
            key={tile.href}
            href={tile.href}
            className="card flex min-h-24 items-center justify-center text-center font-bold [overflow-wrap:anywhere] hover:bg-surface-sunken"
          >
            {tile.icon} {tile.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
