import Link from 'next/link';
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
export default async function CalcDictionariesPage(props: {
  searchParams: Promise<{ kod?: string; baza?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('ved.docs')) redirect('/');

  const t = await getTranslations('calc');
  const tc = await getTranslations('common');
  // A URL param is a forged post (#514): digits only, or it never reaches SQL.
  const params = await props.searchParams;
  const rawKod = params.kod ?? '';
  const kod = /^\d{1,10}$/.test(rawKod.trim()) ? rawKod.trim() : '';
  // A product name, not a code: bounded and passed as a value, never
  // interpolated — the service does the matching in SQL.
  const bazaQ = (params.baza ?? '').trim().slice(0, 80);

  let bazas: Awaited<ReturnType<typeof listBazas>> = [];
  let rates: Awaited<ReturnType<typeof listRates>> = [];
  let tariff: Awaited<ReturnType<typeof listTariff>> = [];
  let prices: Awaited<ReturnType<typeof listPriceBook>> = [];
  try {
    [bazas, rates, tariff, prices] = await Promise.all([
      listBazas(bazaQ),
      listRates(kod),
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
          {/* The rates table has been searchable by CODE since round 68 and
              this one had no filter at all — so past a screenful the only way
              to find a product was the browser's own Ctrl+F. */}
          <form className="mt-2 flex flex-wrap items-end gap-2" method="get">
            <label className="text-2xs">
              <span className="label">{t('bazaSearch')}</span>
              <input
                className="input input-sm !w-56"
                data-testid="dict-baza-search"
                defaultValue={bazaQ}
                name="baza"
              />
            </label>
            <button className="btn" type="submit">
              🔍
            </button>
            {bazaQ ? (
              <Link className="btn-ghost" href="/hisoblash/lugatlar" data-testid="dict-baza-clear">
                {tc('cancel')}
              </Link>
            ) : null}
          </form>
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
                    <td className="p-2">{row.basis === 'unit' ? t('perUnit') : row.basis === 'm2' ? 'm²' : row.basis}</td>
                    <td className="p-2 font-mono tabular-nums">{row.effectiveDate}</td>
                  </tr>
                ))}
                {bazas.length === 0 ? (
                  <tr>
                    <td className="p-2 text-2xs text-ink-500" colSpan={5}>
                      {bazaQ ? t('bazaSearchNone', { q: bazaQ }) : '—'}
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
          {/* The whole PP-3818 book lives underneath (1,489 seeded rows) and
              rendering it all is /stock's DOM crush — so bare, the table
              shows only the VED's own rows, and a typed code searches the
              book both ways: the heading AND its carved-out exceptions. */}
          <form className="mt-2 flex flex-wrap items-end gap-2" method="get">
            <label className="text-2xs">
              <span className="label">{t('rateSearch')}</span>
              <input
                className="input input-sm !w-40 font-mono tabular-nums"
                data-testid="dict-rate-search"
                defaultValue={kod}
                inputMode="numeric"
                name="kod"
              />
            </label>
            <button className="btn" type="submit">
              🔍
            </button>
          </form>
          {!kod ? <p className="mt-1 text-2xs text-ink-500">{t('rateSearchHint')}</p> : null}
          <div className="table-wrap mt-2 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-2xs uppercase text-ink-500">
                  <th className="p-2">TNVED</th>
                  <th className="p-2 text-right">{t('duty')}</th>
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
                      {row.source === 'pp3818' ? (
                        <span className="ml-1 chip chip-neutral">PQ-3818</span>
                      ) : null}
                    </td>
                    {/* A MAX row read as its percentage alone loses the floor,
                        so the cell prints the whole law: «20% / min 3 $/dona». */}
                    <td className="p-2 text-right font-mono tabular-nums">
                      {row.dutyMode === 'advalor'
                        ? `${row.dutyPct}%`
                        : row.dutyMode === 'specific'
                          ? `${row.dutySpecific} $/${row.dutyUnit}`
                          : row.dutyMode === 'max'
                            ? `${row.dutyPct}% / min ${row.dutySpecific} $/${row.dutyUnit}`
                            : `${row.dutyPct}% + ${row.dutySpecific} $/${row.dutyUnit}`}
                    </td>
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
