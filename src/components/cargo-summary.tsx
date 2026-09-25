import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { clientCargo, type ClientCargo } from '@/modules/wms/finance/client-cargo';
import { Icon } from '@/components/ui/icon';

/**
 * One client's cargo and the money on it.
 *
 * The client card and the finance ledger both ask this (owner: "mijoz
 * kartasida buyurtmalar tarixi va qarzi", "qarz qaysi yukdan kelgan"), so
 * they render the same block rather than two views that can disagree.
 *
 * `money` false hides the debt figures for a viewer without finance rights —
 * the cargo half is not a secret, the balances are.
 */
export async function CargoSummary({
  clientId,
  money = true,
  data,
}: {
  clientId: string;
  money?: boolean;
  /** Already read by the page (the ledger's card form lists its trucks) — not read twice. */
  data?: ClientCargo;
}) {
  const cargo = data ?? (await clientCargo(clientId));
  const t = await getTranslations('cargo');
  const format = await getFormatter();

  if (cargo.locations.length === 0 && cargo.trips.length === 0 && (!money || cargo.offTrip.length === 0)) {
    return <p className="text-sm text-ink-500">{t('noCargo')}</p>;
  }

  const stateLabel: Record<string, string> = {
    stock: t('stateStock'),
    transit: t('stateTransit'),
    ready: t('stateReady'),
  };
  const stateTone: Record<string, string> = {
    stock: 'text-ink-700',
    transit: 'text-warn',
    ready: 'text-good',
  };

  return (
    <div className="space-y-3">
      {cargo.locations.length > 0 && (
        <div className="space-y-1">
          <p className="section-title">{t('whereTitle')}</p>
          {cargo.locations.map((loc) => (
            <div
              key={`${loc.warehouseId}-${loc.state}`}
              className="flex flex-wrap items-baseline gap-2 rounded-lg border border-line px-2.5 py-1.5 text-sm"
            >
              <span className="font-mono font-extrabold">{loc.warehouseCode ?? '—'}</span>
              <span className={`text-xs font-semibold ${stateTone[loc.state]}`}>
                {stateLabel[loc.state]}
              </span>
              <span className="num ml-auto whitespace-nowrap">
                {loc.boxCount} 📦 · {loc.kg} kg · {loc.m3} m³
              </span>
            </div>
          ))}
          <p className="num text-right text-sm font-bold">
            Σ {cargo.totals.boxCount} 📦 · {cargo.totals.kg} kg · {cargo.totals.m3} m³
          </p>
        </div>
      )}

      {cargo.trips.length > 0 && (
        <div className="space-y-1">
          <p className="section-title">{t('tripsTitle')}</p>
          {cargo.trips.map((trip) => (
            <Link
              key={trip.batchId}
              href={`/batches/${trip.batchId}`}
              className="card-tap block !p-2.5 text-sm"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono font-extrabold text-brand-700">{trip.batchCode}</span>
                <span className="font-mono text-xs text-ink-500">
                  {trip.originCode} → {trip.destCode}
                </span>
                {trip.departedAt && (
                  <span className="ml-auto whitespace-nowrap text-xs text-ink-500">
                    {format.dateTime(new Date(trip.departedAt), { dateStyle: 'short' })}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex flex-wrap items-baseline gap-2">
                <span className="num text-ink-700">
                  {trip.boxCount} 📦 · {trip.kg} kg · {trip.m3} m³
                </span>
                {money && trip.chargedUsd > 0 && (
                  <span className="num ml-auto whitespace-nowrap">
                    {t('charged')}: <b>${trip.chargedUsd.toFixed(2)}</b>
                    {trip.owedUsd > 0.009 ? (
                      <b className="text-bad"> · {t('owed')} ${trip.owedUsd.toFixed(2)}</b>
                    ) : (
                      <b className="text-good"> · {t('settled')}</b>
                    )}
                  </span>
                )}
                {/* An internal truck is never priced (owner's C1a) — «narx
                    qo'yilmagan» is false of it. What CAN be missing there is
                    its own cost, and that is the warning it carries. A charge
                    already posted on one (before the rule) still prints above.
                    «Priced» is the unpriced-cargo rule's own answer (0104),
                    not «something was charged on this truck»: a prixod split
                    over two trucks and priced once is priced on both. */}
                {money && trip.unpriced && !trip.internal && (
                  <span className="ml-auto whitespace-nowrap text-xs text-warn" data-testid="trip-unpriced">
                    {t('notPriced')}
                  </span>
                )}
                {money && !trip.unpriced && trip.chargedUsd === 0 && !trip.internal && (
                  <span className="ml-auto whitespace-nowrap text-xs text-ink-500">{t('pricedElsewhere')}</span>
                )}
                {money && trip.dropped && (
                  <span className="w-full text-xs text-warn" data-testid="trip-dropped">
                    {t('tripDropped', { n: trip.dropped.boxes })}
                    {trip.dropped.to.length > 0 && ` → ${trip.dropped.to.join(', ')}`}
                  </span>
                )}
                {money && trip.chargedUsd === 0 && trip.internal && (
                  <span
                    className={`ml-auto whitespace-nowrap text-xs ${trip.costMissing ? 'text-warn' : 'text-ink-500'}`}
                    data-testid="trip-internal"
                  >
                    {trip.costMissing ? `⚠️ ${t('internalNoCost')}` : t('internalTrip')}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Prices on trucks the cargo did not ride (0104): still loading there,
          or nothing of the client on it at all (Q21). Money viewers only — a
          row IS a price. */}
      {money && cargo.offTrip.length > 0 && (
        <div className="space-y-1">
          {cargo.offTrip.map((off) => (
            <Link
              key={off.batchId}
              href={`/batches/${off.batchId}`}
              className="card-tap flex flex-wrap items-baseline gap-2 !p-2.5 text-sm"
              data-testid="trip-off"
            >
              <span className="font-mono font-extrabold text-brand-700">{off.batchCode}</span>
              <span className={`text-xs font-semibold ${off.reason === 'no_cargo' ? 'text-warn' : 'text-ink-500'}`}>
                {off.reason === 'no_cargo' ? t('offTripNoCargo') : t('offTripLoading')}
                {off.droppedTo.length > 0 && ` → ${off.droppedTo.join(', ')}`}
              </span>
              <span className="num ml-auto whitespace-nowrap">
                {t('charged')}: <b>${off.chargedUsd.toFixed(2)}</b>
                {off.owedUsd > 0.009 && <b className="text-bad"> · {t('owed')} ${off.owedUsd.toFixed(2)}</b>}
              </span>
            </Link>
          ))}
        </div>
      )}

      {money && (cargo.chargedUsd > 0 || cargo.paidUsd > 0) && (
        <div className="flex flex-wrap items-baseline gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-sm">
          <Icon name="wallet" className="h-4 w-4 text-ink-400" />
          <span className="num">
            {t('chargedTotal')} <b>${cargo.chargedUsd.toFixed(2)}</b>
          </span>
          <span className="num">
            {t('paidTotal')} <b>${cargo.paidUsd.toFixed(2)}</b>
          </span>
          <span className={`num ml-auto font-extrabold ${cargo.balanceUsd > 0.009 ? 'text-bad' : 'text-good'}`}>
            {t('balance')} ${cargo.balanceUsd.toFixed(2)}
          </span>
          {cargo.unassignedOwedUsd > 0.009 && (
            <span className="num w-full text-xs text-ink-500">
              {t('unassignedOwed', { amount: cargo.unassignedOwedUsd.toFixed(2) })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
