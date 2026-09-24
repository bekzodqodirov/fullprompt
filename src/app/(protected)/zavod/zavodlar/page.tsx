import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader } from '@/components/ui/page';
import { listFactories, mayReadPickups, PICKUP_WRITE } from '@/modules/wms/pickups/service';
import { FactoryActiveToggle, FactoryForm, FactoryPointForm } from './factory-forms';

export const dynamic = 'force-dynamic';

/**
 * The factory directory (owner's B6): name, the Chinese address, phone,
 * WeChat, what we buy there — so a problem with the goods next month has a
 * number to call. The map pin is a geocoder's suggestion until a person
 * says «✓ to'g'ri» or places it by hand.
 */
export default async function FactoriesPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!mayReadPickups(actor.permissions)) redirect('/');
  const t = await getTranslations('pickups');
  const canWrite = actor.permissions.has(PICKUP_WRITE);
  const rows = await listFactories({ includeInactive: true });

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <PageHeader icon="briefcase" title={t('factories')} back={{ href: '/zavod', label: t('title') }} />
      {canWrite && (
        <details className="card" open={rows.length === 0}>
          <summary className="cursor-pointer font-semibold">+ {t('newFactory')}</summary>
          <div className="mt-2">
            <FactoryForm />
          </div>
        </details>
      )}
      <ul className="space-y-2">
        {rows.map((f) => {
          const point =
            f.lat === null
              ? { text: t('pointNone'), cls: 'chip-warn' }
              : f.geoConfirmedAt
                ? { text: t('pointConfirmed'), cls: 'chip-good' }
                : { text: t('pointSuggested'), cls: 'chip-neutral' };
          return (
            <li key={f.id} className={`card space-y-1 ${f.active ? '' : 'opacity-60'}`} data-testid="factory-row">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-semibold">{f.name}</span>
                <span className={`chip ${point.cls}`} data-testid="factory-point-state">📍 {point.text}</span>
                {!f.active && <span className="chip chip-neutral">{t('inactive')}</span>}
              </p>
              <p className="text-xs text-ink-700">
                {[f.address, f.phone, f.wechat && `WeChat: ${f.wechat}`, f.goodsNote].filter(Boolean).join(' · ')}
              </p>
              {f.lat !== null && (
                <p className="text-xs text-ink-500">
                  {Number(f.lat).toFixed(5)}, {Number(f.lon).toFixed(5)}
                  {f.geoLabel && ` · ${f.geoLabel}`}
                </p>
              )}
              {canWrite && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-brand-700">✏️ {t('edit')}</summary>
                  <div className="mt-2 space-y-3">
                    <FactoryForm
                      initial={{
                        id: f.id,
                        name: f.name,
                        address: f.address ?? '',
                        phone: f.phone ?? '',
                        wechat: f.wechat ?? '',
                        goodsNote: f.goodsNote ?? '',
                        note: f.note ?? '',
                      }}
                    />
                    <FactoryPointForm id={f.id} hasPoint={f.lat !== null} confirmed={Boolean(f.geoConfirmedAt)} />
                    <FactoryActiveToggle id={f.id} active={f.active} />
                  </div>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
