import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { upsaleScopeFor } from '@/modules/wms/calc/upsale-scope';
import { mayReadCalcRegistry } from '@/modules/wms/calc/control-scope';
import { quoteHistoryFor } from '@/modules/wms/calc/history';
import { priceBookAt } from '@/modules/wms/calc/dictionaries';
import { SECTION_LABELS } from '@/modules/wms/calc/labels';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { PageHeader } from '@/components/ui/page';

/**
 * «Narx tarixi» — his law 10, «sotuvchi va vedga narxlar tarixi ko'rinsa».
 *
 * Open to the SELLERS as well as the VED, because the question it answers
 * («what did we charge for this last time») is asked far more often at the
 * moment of quoting than at the moment of calculating. It carries no
 * customer name and no card link the reader could not already open: the row
 * links to the card, and the card's own gate decides.
 *
 * Deliberately NOT a group in the global search. `globalSearch` runs its
 * groups in one `Promise.all` with no catch, so a table that landed in this
 * release would take ⌘K down on deploy morning for everybody (#472).
 */
export default async function PriceHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ kod?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  // Two audiences on one screen (laws 4 and 10): the VED reads the cost side
  // and never a client price, the seller reads the prices and never the floor.
  const scope = upsaleScopeFor(actor);
  // The door is the SCOPE, and the VED's own grant beside it.
  //
  // It used to be `canWriteDeal || ved.docs`, which locked out the one person
  // law 4 names explicitly besides the owner: the ACCOUNTANT, who pays the
  // upsale out and holds none of `crm.leads` / `ved.docs` / `clients.manage`.
  // Measured in a browser as the buxgalter — redirected to the home screen.
  if (scope === 'none' && !actor.permissions.has('ved.docs')) redirect('/');

  const { kod } = await searchParams;
  const code = (kod ?? '').trim();

  const t = await getTranslations('calc');
  const tc = await getTranslations('common');
  const format = await getFormatter();

  let rows: Awaited<ReturnType<typeof quoteHistoryFor>> = [];
  let book: Awaited<ReturnType<typeof priceBookAt>> = null;
  if (code) {
    try {
      [rows, book] = await Promise.all([
        quoteHistoryFor(code, { scope, limit: 10 }),
        priceBookAt(code, new Date().toISOString().slice(0, 10)),
      ]);
    } catch (err) {
      if (!isServerBehind(err)) throw err;
      logger.error({ err, code }, '[calc] price history: server behind');
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        icon="report"
        title={t('historyTitle')}
        back={{ href: '/hisoblash', label: t('queueTitle') }}
        actions={
          // The accountant's door to phase E1: they cannot open /hisoblash at
          // all (it gates on `ved.docs`), and this page is the one screen in
          // the module their grants already reach.
          <>
            {scope === 'all' || actor.permissions.has('ved.docs') ? (
              <Link
                href="/hisoblash/nazorat"
                className="btn-secondary"
                data-testid="calc-control-link"
              >
                {t('controlTitle')}
              </Link>
            ) : null}
            {/* The registry of SEALED calculations — same reasoning: the
                accountant reaches it from here or from nowhere. Gated by the
                registry's own door, so a seller standing on this screen is
                not shown a link to a redirect. */}
            {mayReadCalcRegistry(actor) ? (
              <Link
                href="/hisoblash/tarix"
                className="btn-secondary"
                data-testid="calc-registry-link"
              >
                {t('registryTitle')}
              </Link>
            ) : null}
          </>
        }
      />

      {/* A plain GET form: the code is in the address bar, so a found answer
          is a link a seller can send a colleague. */}
      <form className="card flex flex-wrap items-end gap-2 !p-3" data-testid="history-form">
        <label className="text-2xs">
          <span className="label">{t('historySearch')}</span>
          <input
            name="kod"
            className="input input-sm !w-40 font-mono tabular-nums"
            data-testid="history-code"
            defaultValue={code}
          />
        </label>
        <button type="submit" className="btn-primary" data-testid="history-go">
          {tc('search')}
        </button>
        <p className="w-full text-2xs text-ink-500">{t('historyHint')}</p>
      </form>

      {book ? (
        <div className="card !p-3" data-testid="history-book">
          <p className="text-2xs uppercase text-ink-500">{t('dictPrice')}</p>
          <p className="font-mono text-lg font-bold tabular-nums">
            ${book.priceUsd} / {book.unit === 'kg' ? t('unitKg') : t('unitM3')}
          </p>
          <p className="text-2xs text-ink-500">
            {book.label} · {book.effectiveDate}
          </p>
        </div>
      ) : null}

      {code ? (
        rows.length > 0 ? (
          <ul className="space-y-2" data-testid="history-rows">
            {rows.map((row) => (
              <li key={row.versionId} className="card !p-3" data-testid="history-row">
                <div className="flex flex-wrap items-baseline gap-2">
                  {/* Always labelled with its section: a per-cube figure is
                      freight alone on a yolkira quote and everything on a
                      podklyuch one, and one column would compare three
                      different services. */}
                  <span className="chip chip-brand">
                    {t(SECTION_LABELS[row.section] as 'sections.podklyuch')}
                  </span>
                  {row.totalUsd !== null ? (
                    <span className="font-mono text-base font-bold tabular-nums">
                      ${row.totalUsd.toFixed(2)}
                    </span>
                  ) : null}
                  <span className="text-2xs text-ink-500">
                    {format.dateTime(row.sealedAt, { dateStyle: 'short' })}
                  </span>
                  {/* The card behind this link prints the sealed floor with no
                      ownership gate of its own, so for a seller the link is a
                      door to the number the row above deliberately hides. */}
                  {row.cardReadable ? (
                    <Link
                      className="text-2xs text-brand-700"
                      href={
                        row.entityType === 'deal'
                          ? `/bitimlar/${row.entityId}`
                          : `/crm/leads/${row.entityId}`
                      }
                      data-testid="history-card-link"
                    >
                      {t('openCard')} →
                    </Link>
                  ) : null}
                </div>

                <p className="text-2xs text-ink-600">
                  {row.groupLabel}
                  {row.volumeM3 !== null ? ` · ${row.volumeM3} m³` : ''}
                  {row.weightKg !== null ? ` · ${row.weightKg} kg` : ''}
                  {row.perM3Usd !== null ? ` · $${row.perM3Usd.toFixed(2)}/m³` : ''}
                  {row.perKgUsd !== null ? ` · $${row.perKgUsd.toFixed(2)}/kg` : ''}
                </p>

                {/* The per-product figure is CUSTOMS only, and only when the
                    group's every item carries the measure — freight is never
                    allocated onto a product, because a mixed load's band is
                    not any one product's band. */}
                {row.groupCustomsUsd !== null ? (
                  <p className="text-2xs text-ink-500" data-testid="history-group">
                    {t('customs')}: ${row.groupCustomsUsd.toFixed(2)}
                    {row.groupCustomsPerM3 !== null ? ` · $${row.groupCustomsPerM3}/m³` : ''}
                    {row.groupCustomsPerUnit !== null
                      ? ` · $${row.groupCustomsPerUnit}/${t('perUnit')}`
                      : ''}
                  </p>
                ) : null}

                {row.clientPriceUsd !== null ? (
                  <p className="text-2xs" data-testid="history-offer">
                    <span className="text-ink-500">{t('clientPrice')}:</span>{' '}
                    <span className="font-mono font-semibold tabular-nums">
                      ${row.clientPriceUsd.toFixed(2)}
                    </span>
                    {row.belowFloor ? (
                      <span className="ml-1 chip chip-warn">{t('belowFloorChip')}</span>
                    ) : null}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-500" data-testid="history-none">
            {t('historyNone')}
          </p>
        )
      ) : null}
    </div>
  );
}
