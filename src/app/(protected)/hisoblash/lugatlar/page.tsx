import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import {
  listBazas,
  listPriceBook,
  listRates,
  listTariff,
} from '@/modules/wms/calc/dictionaries';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { PageHeader, Section } from '@/components/ui/page';
import { BazaForm, PriceBookForm, RatesForm } from './dict-forms';

/**
 * The VED person's own dictionaries — the product baza and the code rates.
 *
 * They live under `/hisoblash` and NOT under `/admin`, and that is a fact
 * about access rather than about tidiness: the section layout gates `/admin`
 * on six permissions, none of which a `ved_manager` holds, so a dictionary
 * put there would be a dictionary its owner cannot open.
 *
 * The freight TARIFF is shown here read-only and edited under `/admin`. It is
 * the list price a VED discount is measured against, so the person giving the
 * discount must not be the person who can move the list.
 */
export default async function CalcDictionariesPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('ved.docs')) redirect('/');

  const t = await getTranslations('calc');

  let bazas: Awaited<ReturnType<typeof listBazas>> = [];
  let rates: Awaited<ReturnType<typeof listRates>> = [];
  let tariff: Awaited<ReturnType<typeof listTariff>> = [];
  let prices: Awaited<ReturnType<typeof listPriceBook>> = [];
  try {
    [bazas, rates, tariff, prices] = await Promise.all([
      listBazas(),
      listRates(),
      listTariff(),
      listPriceBook(),
    ]);
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err }, '[calc] dictionaries: server behind');
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        icon="clipboard"
        title={t('dictTitle')}
        back={{ href: '/hisoblash', label: t('queueTitle') }}
      />

      <Section title={t('dictBaza')}>
        <div className="card !p-3" data-testid="dict-baza">
          <BazaForm />
          <div className="table-wrap mt-2 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-2xs uppercase text-ink-500">
                  <th className="p-2">{t('product')}</th>
                  <th className="p-2">TNVED</th>
                  <th className="p-2 text-right">{t('baza')}</th>
                  <th className="p-2">{t('basis')}</th>
                  <th className="p-2">{t('effectiveDate')}</th>
                </tr>
              </thead>
              <tbody>
                {bazas.map((row) => (
                  <tr key={row.id} className="border-b border-line/60" data-testid="dict-baza-row">
                    <td className="p-2">
                      {row.label}
                      {/* «har 3 oyda ko'rib chiqish» — a warning, never a refusal. */}
                      {row.stale ? <span className="ml-1 chip chip-warn">{t('stale')}</span> : null}
                      {row.future ? <span className="ml-1 chip chip-neutral">{t('future')}</span> : null}
                    </td>
                    <td className="p-2 font-mono tabular-nums">{row.tnvedCode ?? '—'}</td>
                    <td className="p-2 text-right font-mono tabular-nums">${row.bazaUsd}</td>
                    <td className="p-2">{row.basis === 'kg' ? 'kg' : t('perUnit')}</td>
                    <td className="p-2 font-mono tabular-nums">{row.effectiveDate}</td>
                  </tr>
                ))}
                {bazas.length === 0 ? (
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
      </Section>

      <Section title={t('dictRates')}>
        <div className="card !p-3" data-testid="dict-rates">
          <RatesForm />
          <div className="table-wrap mt-2 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-2xs uppercase text-ink-500">
                  <th className="p-2">TNVED</th>
                  <th className="p-2 text-right">{t('duty')} %</th>
                  <th className="p-2 text-right">{t('vat')} %</th>
                  <th className="p-2 text-right">{t('fee')} $</th>
                  <th className="p-2">{t('effectiveDate')}</th>
                </tr>
              </thead>
              <tbody>
                {rates.map((row) => (
                  <tr key={row.id} className="border-b border-line/60" data-testid="dict-rate-row">
                    <td className="p-2 font-mono tabular-nums">
                      {row.tnvedCode}
                      {row.future ? <span className="ml-1 chip chip-neutral">{t('future')}</span> : null}
                    </td>
                    <td className="p-2 text-right font-mono tabular-nums">{row.dutyPct}</td>
                    <td className="p-2 text-right font-mono tabular-nums">{row.vatPct}</td>
                    <td className="p-2 text-right font-mono tabular-nums">{row.feeUsd}</td>
                    <td className="p-2 font-mono tabular-nums">{row.effectiveDate}</td>
                  </tr>
                ))}
                {rates.length === 0 ? (
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
      </Section>

      {/* The price book. It sits between the rates and the tariff on purpose:
          the two above it are what a shipment COSTS, this one is what it has
          been SOLD for, and the tariff below is the list price a discount is
          measured against. */}
      <Section title={t('dictPrice')}>
        <div className="card !p-3" data-testid="dict-price">
          <PriceBookForm />
          <div className="table-wrap mt-2 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-2xs uppercase text-ink-500">
                  <th className="p-2">TNVED</th>
                  <th className="p-2">{t('product')}</th>
                  <th className="p-2 text-right">{t('price')}</th>
                  <th className="p-2">{t('priceUnit')}</th>
                  <th className="p-2">{t('effectiveDate')}</th>
                </tr>
              </thead>
              <tbody>
                {prices.map((row) => (
                  <tr key={row.id} className="border-b border-line/60" data-testid="dict-price-row">
                    <td className="p-2 font-mono tabular-nums">{row.tnvedCode}</td>
                    <td className="p-2">
                      {row.label}
                      {row.stale ? <span className="ml-1 chip chip-warn">{t('stale')}</span> : null}
                      {row.future ? <span className="ml-1 chip chip-neutral">{t('future')}</span> : null}
                    </td>
                    <td className="p-2 text-right font-mono tabular-nums">${row.priceUsd}</td>
                    <td className="p-2">{row.unit === 'kg' ? t('unitKg') : t('unitM3')}</td>
                    <td className="p-2 font-mono tabular-nums">{row.effectiveDate}</td>
                  </tr>
                ))}
                {prices.length === 0 ? (
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
      </Section>

      <Section title={t('dictTariff')}>
        <div className="card !p-3" data-testid="dict-tariff">
          <p className="text-2xs text-ink-500">{t('tariffReadOnly')}</p>
          <div className="table-wrap mt-2 overflow-x-auto">
            <table className="w-full min-w-[28rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-2xs uppercase text-ink-500">
                  <th className="p-2">{t('zone')}</th>
                  <th className="p-2 text-right">{t('minDensity')}</th>
                  <th className="p-2 text-right">{t('maxDensity')}</th>
                  <th className="p-2 text-right">{t('price')}</th>
                </tr>
              </thead>
              <tbody>
                {tariff.map((row) => (
                  <tr key={row.id} className="border-b border-line/60">
                    <td className="p-2">
                      {t.has(`zones.${row.zone}`) ? t(`zones.${row.zone}` as 'zones.cn') : row.zone}
                    </td>
                    <td className="p-2 text-right font-mono tabular-nums">{row.minDensity}</td>
                    <td className="p-2 text-right font-mono tabular-nums">{row.maxDensity ?? '∞'}</td>
                    <td className="p-2 text-right font-mono tabular-nums">
                      ${row.priceUsd} / {row.perKg ? 'kg' : 'm³'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Section>
    </div>
  );
}
