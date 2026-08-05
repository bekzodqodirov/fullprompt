import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { Icon } from '@/components/ui/icon';
import {
  canWriteDeal,
  dealRealitiesFor,
  deviationThreshold,
  compareQuote,
  listDeals,
} from '@/modules/wms/deals/service';
import { worthAlerting } from '@/modules/wms/deals/deviation';

/**
 * This client's jobs, on their card.
 *
 * The owner's question when he opens a client is "what are we doing for them
 * right now and is any of it going wrong" — and until deals existed the card
 * could only answer the first half from the cargo summary. A deal whose cargo
 * came out over the threshold is marked here, because the client card is where
 * a salesperson looks before picking up the phone.
 */
export async function ClientDeals({ clientId }: { clientId: string }) {
  const actor = await getActor();
  if (!actor || !canWriteDeal(actor.permissions)) return null;

  const t = await getTranslations('deals');
  const rows = await listDeals({ clientId, limit: 30 });
  // Grouped, the board's shape: this was two queries per deal plus a refetch
  // for the quote, on a card that already runs a dozen reads.
  const [threshold, realities] = await Promise.all([
    deviationThreshold(),
    dealRealitiesFor(rows.map((row) => row.id)),
  ]);

  const withGap = rows.map((row) => {
    const reality = realities.get(row.id);
    if (!reality || reality.receiptCount === 0) return { row, pct: null, unpriced: false };
    if (row.quotedAmount === null) return { row, pct: null, unpriced: true };
    const deviation = compareQuote(
      {
        volumeM3: row.quotedVolumeM3 === null ? null : Number(row.quotedVolumeM3),
        weightKg: row.quotedWeightKg === null ? null : Number(row.quotedWeightKg),
        amount: Number(row.quotedAmount),
      },
      { volumeM3: reality.volumeM3, weightKg: reality.weightKg },
      threshold,
    );
    return { row, pct: worthAlerting(deviation) ? deviation.worstPct : null, unpriced: false };
  });

  return (
    <section className="card space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-bold">🤝 {t('title')}</h2>
        <Link
          href={`/bitimlar/new?client=${clientId}`}
          data-testid="client-new-deal"
          className="btn-secondary"
        >
          <Icon name="plus" className="h-4 w-4" />
          {t('newDeal')}
        </Link>
      </div>

      {withGap.length === 0 && <p className="text-sm text-ink-500">{t('empty')}</p>}

      {withGap.map(({ row, pct, unpriced }) => (
        <Link
          key={row.id}
          href={`/bitimlar/${row.id}`}
          data-testid="client-deal-row"
          className="block rounded-xl border border-line p-2 hover:bg-surface-sunken"
        >
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="num text-xs font-bold text-ink-500">{row.code}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">
              {row.title || '—'}
            </span>
            {row.quotedAmount ? (
              <span className="num text-sm font-bold">
                {row.quotedAmount} {row.quotedCurrency}
              </span>
            ) : (
              <span className="text-xs font-semibold text-warn">{t('notQuoted')}</span>
            )}
          </div>
          {(pct !== null || unpriced || row.deferred) && (
            <div className="mt-1 flex flex-wrap gap-2 text-[11px] font-bold">
              {pct !== null && (
                <span className="text-bad">
                  ⚖️ {pct > 0 ? '+' : ''}
                  {pct.toFixed(0)} % · {t('deviation')}
                </span>
              )}
              {unpriced && <span className="text-bad">💰❓ {t('unpriced')}</span>}
              {row.deferred && <span className="text-warn">⏳ {t('deferred')}</span>}
            </div>
          )}
        </Link>
      ))}
    </section>
  );
}
