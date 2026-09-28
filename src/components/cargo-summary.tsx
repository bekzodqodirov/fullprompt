import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { clientCargo, type ClientCargo } from '@/modules/wms/finance/client-cargo';
import { clientCargoNowOnce } from '@/modules/wms/inventory/client-cargo-now';
import { foldCargoNow, NOW_SECTIONS, sectionCounts, type NowSection } from '@/modules/wms/inventory/client-cargo-fold';
import { groupDigits } from '@/modules/platform/telegram/format';
import { tashkentDay } from '@/modules/platform/time/tashkent';
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
 *
 * «Where is it now» is ONE line here — the customer's steps and the Σ — from
 * the client card's «Yuklar» tab's own read and fold, so the card, the ledger
 * and the tab print one number (#513). It used to be a per-warehouse list
 * with three states of its own, which put a truck at customs under «в пути»
 * while the customer's Mini App said «O'zbekistonda». `yuklarHref` links the
 * line to the tab; the ledger passes it only when the reader may open the
 * card (the accountant and the VED read «Pul» and not «Yuklar»).
 */
export async function CargoSummary({
  clientId,
  money = true,
  data,
  yuklarHref = null,
}: {
  clientId: string;
  money?: boolean;
  /** Already read by the page (the ledger's card form lists its trucks) — not read twice. */
  data?: ClientCargo;
  /** The «Yuklar» tab, for a reader its door admits; null draws no link. */
  yuklarHref?: string | null;
}) {
  const [cargo, nowData] = await Promise.all([data ?? clientCargo(clientId), clientCargoNowOnce(clientId)]);
  const t = await getTranslations('cargo');
  const ty = await getTranslations('yuklar');
  const format = await getFormatter();
  const now = foldCargoNow(nowData.rows, nowData.trucks, null, tashkentDay());
  const counts = sectionCounts(now);
  const missing = now.missing.reduce((acc, m) => acc + m.n, 0);
  const hasNow = now.total.boxes > 0 || missing > 0;

  if (!hasNow && cargo.trips.length === 0 && (!money || cargo.offTrip.length === 0)) {
    return <p className="text-sm text-ink-500">{t('noCargo')}</p>;
  }

  // A literal map — a key built at runtime is one the i18n fence cannot see (#163).
  const sectionLabel: Record<NowSection, string> = {
    china: ty('sections.china'),
    transit: ty('sections.transit'),
    uz: ty('sections.uz'),
    ready: ty('sections.ready'),
  };

  return (
    <div className="space-y-3">
      {hasNow && (
        <div className="space-y-1" data-testid="cargo-now">
          <p className="section-title">{t('whereTitle')}</p>
          <p className="flex flex-wrap gap-x-3 text-sm">
            {NOW_SECTIONS.filter((s) => counts[s] > 0).map((s) => (
              <span key={s} className="whitespace-nowrap">
                {sectionLabel[s]} · <b className="font-mono tabular-nums">{groupDigits(counts[s])}</b>
              </span>
            ))}
            {missing > 0 && (
              <span className="whitespace-nowrap font-semibold text-warn">
                ⚠ {ty('missing')} · {groupDigits(missing)}
              </span>
            )}
          </p>
          <p className="flex flex-wrap items-baseline gap-x-3 text-sm">
            <b className="font-mono tabular-nums" data-testid="cargo-now-total">
              Σ {groupDigits(now.total.boxes)} 📦 · {groupDigits(now.total.kg)} kg · {groupDigits(now.total.m3)} m³
            </b>
            {yuklarHref && (
              <Link href={yuklarHref} className="text-brand-700 underline" data-testid="cargo-now-link">
                {ty('openTab')} →
              </Link>
            )}
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
          {cargo.compensatedUsd > 0.009 && (
            <span className="num text-ink-500" data-testid="cargo-compensated">
              {t('compensatedTotal')} <b>${cargo.compensatedUsd.toFixed(2)}</b>
            </span>
          )}
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
