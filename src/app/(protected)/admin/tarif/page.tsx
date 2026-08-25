import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { listTariff } from '@/modules/wms/calc/dictionaries';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { TariffForm } from './tariff-form';

/**
 * The freight tariff — the owner's own table, editable and versioned.
 *
 * It sits under `/admin` on purpose. The VED person gives the discount, and a
 * discount is only meaningful against a list price he does not control; the
 * same table is on his own screen, read-only.
 *
 * Editing keeps history rather than overwriting: a row is (zone, floor, date)
 * and a calculation reads the newest row on or before its own day, so an old
 * sealed quote goes on reading the tariff that made it.
 */
export default async function TariffPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('admin.dictionaries.manage')) redirect('/');
  const t = await getTranslations('calc');

  let rows: Awaited<ReturnType<typeof listTariff>> = [];
  try {
    rows = await listTariff();
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err }, '[calc] tariff: server behind');
  }

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <h1 className="text-xl font-bold">🚚 {t('dictTariff')}</h1>
      <div className="card !p-3" data-testid="tariff-admin">
        <TariffForm zones={[...new Set(rows.map((r) => r.zone))]} />
        <div className="table-wrap mt-3 overflow-x-auto">
          <table className="w-full min-w-[30rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-2xs uppercase text-ink-500">
                <th className="p-2">{t('zone')}</th>
                <th className="p-2 text-right">{t('minDensity')}</th>
                <th className="p-2 text-right">{t('maxDensity')}</th>
                <th className="p-2 text-right">{t('price')}</th>
                <th className="p-2">{t('effectiveDate')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line/60" data-testid="tariff-row">
                  <td className="p-2">
                    {t.has(`zones.${row.zone}`) ? t(`zones.${row.zone}` as 'zones.cn') : row.zone}
                    {row.future ? <span className="ml-1 chip chip-neutral">{t('future')}</span> : null}
                  </td>
                  <td className="p-2 text-right font-mono tabular-nums">{row.minDensity}</td>
                  <td className="p-2 text-right font-mono tabular-nums">{row.maxDensity ?? '∞'}</td>
                  <td className="p-2 text-right font-mono tabular-nums">
                    ${row.priceUsd} / {row.perKg ? 'kg' : 'm³'}
                  </td>
                  <td className="p-2 font-mono tabular-nums">{row.effectiveDate}</td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td className="p-2 text-ink-500" colSpan={5}>
                    —
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
