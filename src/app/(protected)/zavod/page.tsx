import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader } from '@/components/ui/page';
import { listPickups, mayReadPickups, PICKUP_WRITE } from '@/modules/wms/pickups/service';

export const dynamic = 'force-dynamic';

const TABS = ['live', 'arrived', 'cancelled', 'all'] as const;

/**
 * «Zavod reysi» — the trucks we hire to collect from the factories (owner,
 * 2026-09-24, B1). The logist writes them; the accountant and the VED open
 * them to enter the truck's cost; the warehouse sees its incoming ones on
 * /receive and has no reason to be here.
 */
export default async function PickupsPage({ searchParams }: { searchParams: Promise<{ holat?: string }> }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!mayReadPickups(actor.permissions)) redirect('/');
  const t = await getTranslations('pickups');
  const params = await searchParams;
  const tab = (TABS as readonly string[]).includes(params.holat ?? '') ? (params.holat as (typeof TABS)[number]) : 'live';
  const rows = await listPickups({ status: tab });
  const canWrite = actor.permissions.has(PICKUP_WRITE);

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <PageHeader
        icon="truck"
        title={t('title')}
        actions={
          <>
            <Link href="/zavod/zavodlar" className="btn-secondary" data-testid="factories-link">
              🏭 {t('factories')}
            </Link>
            {canWrite && (
              <Link href="/zavod/yangi" className="btn-primary" data-testid="pickup-new">
                + {t('new')}
              </Link>
            )}
          </>
        }
      />
      <nav className="flex gap-1 overflow-x-auto text-sm">
        {TABS.map((key) => (
          <Link
            key={key}
            href={key === 'live' ? '/zavod' : `/zavod?holat=${key}`}
            className={`shrink-0 rounded-full px-3 py-1 ${key === tab ? 'bg-brand-600 text-white' : 'bg-surface-sunken'}`}
          >
            {t(`tabs.${key}`)}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <p className="card text-sm text-ink-500">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map(({ pickup, destCode, stops, liveCostCount }) => {
            const collected = stops.filter((s) => s.collectedAt).length;
            const boxes = stops.flatMap((s) => s.lines).reduce((a, l) => a + l.factoryBoxes, 0);
            return (
              <li key={pickup.id}>
                <Link href={`/zavod/${pickup.id}`} className="card block space-y-1 hover:bg-surface-sunken" data-testid="pickup-row">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono font-bold">{pickup.code}</span>
                    <span className="chip chip-neutral">{t(`status.${pickup.status}`)}</span>
                    <span className="text-xs text-ink-500">→ {destCode}</span>
                    {pickup.vehiclePlate && <span className="text-xs text-ink-500">{pickup.vehiclePlate}</span>}
                  </p>
                  <p className="truncate text-xs text-ink-500">
                    {stops.map((s) => `${s.seq}. ${s.factory.name}${s.collectedAt ? ' ✓' : ''}`).join(' · ')}
                  </p>
                  <p className="text-xs text-ink-700">
                    {t('rowSummary', { collected, stops: stops.length, boxes })}
                    {pickup.status === 'arrived' && liveCostCount === 0 && (
                      <span className="ml-2 font-semibold text-warn">⚠ {t('noCost')}</span>
                    )}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
