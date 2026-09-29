import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  isMixed,
  visibleReasons,
  type PickedHistory,
  type PriceHistory,
  type PriceHistoryRow,
  type PriceMatch,
  type SimilarPickRecord,
} from '@/modules/wms/finance/price-history';
import { SimilarAiButton } from './similar-ai-button';

/**
 * «📈 Oldingi narx»'s body — the rows the icon opens to (owner's 16a/17a).
 *
 * Two lines a row, because at 360 px one line of date · truck · client ·
 * $/m³ · $/kg · density · «aralash» wraps wherever it likes: the first line
 * says WHERE the price was (date, truck, client), the second WHAT it was.
 *
 * The truck links to its own «Narx» tab only for a reader that door admits
 * (`truckLinks`, `mayOpenBatchPricing`) — a link that bounces is worse than
 * none (#1023). The client code is plain text: this page is not where a
 * client's card is opened from.
 *
 * $/kg is labelled with the page's own «/kg yuklangan» — it divides by the
 * kilos LOADED on that truck, which is also what this page's cost line means
 * by it, and there is no second arrived-kilo rule to invent here.
 */
const MATCH_WORDS: Record<PriceMatch, 'priceHistoryMatchExact' | 'priceHistoryMatchCode' | 'priceHistoryMatchName' | 'priceHistoryMatchAi'> = {
  exact: 'priceHistoryMatchExact',
  code: 'priceHistoryMatchCode',
  name: 'priceHistoryMatchName',
  ai: 'priceHistoryMatchAi',
};

const ddmm = (day: string) => {
  const [, m, d] = day.split('-');
  return `${d}.${m}`;
};

async function Rows({ rows, truckLinks }: { rows: PriceHistoryRow[]; truckLinks: boolean }) {
  const t = await getTranslations('finance');
  return (
    <ul className="space-y-1.5" data-testid="price-history-rows">
      {rows.map((row) => (
        <li key={`${row.clientId}:${row.batchId}`} className="break-words" data-testid="price-history-row">
          <p className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="font-mono tabular-nums">{ddmm(row.departedDay)}</span>
            <span className="text-ink-400">·</span>
            {truckLinks ? (
              <Link href={`/batches/${row.batchId}/pricing`} className="font-mono text-brand-700 underline-offset-2 hover:underline">
                {row.batchCode}
              </Link>
            ) : (
              <span className="font-mono">{row.batchCode}</span>
            )}
            <span className="text-ink-400">·</span>
            <span className="font-mono">{row.clientCode ?? '—'}</span>
            {row.own ? <span className="chip chip-brand">{t('priceHistoryOwnMark')}</span> : null}
            <span className="chip chip-neutral">{t(MATCH_WORDS[row.match])}</span>
          </p>
          <p className="font-mono tabular-nums text-ink-600">
            {[
              row.usdPerM3 !== null ? `$${row.usdPerM3.toFixed(2)}/m³` : null,
              row.usdPerKg !== null ? `$${row.usdPerKg.toFixed(2)}${t('perKgLoaded')}` : null,
              row.kgPerM3 !== null ? `${row.kgPerM3} kg/m³` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            {isMixed(row) ? (
              <span className="font-sans text-warn"> · {t('priceHistoryMixed', { n: row.goodsKinds })}</span>
            ) : null}
            {row.cargoMoved ? <span className="font-sans text-warn"> · ⚠ {t('priceHistoryCargoMoved')}</span> : null}
          </p>
        </li>
      ))}
    </ul>
  );
}

export async function PriceHistoryBody({
  history,
  pick,
  picked,
  lotId,
  batchId,
  truckLinks,
}: {
  history: PriceHistory;
  /** The model's stored answer for this lot, when one was asked for. */
  pick: SimilarPickRecord | null;
  /** Its lots, priced by the ledger for THIS reader (`pricedRowsForLots`). */
  picked: PickedHistory | null;
  lotId: string;
  batchId: string;
  truckLinks: boolean;
}) {
  const t = await getTranslations('finance');
  if (history.failed || picked?.failed) {
    return (
      <p className="text-xs text-warn" data-testid="price-history-failed">
        ⚠ {t('priceHistoryFailed')}
      </p>
    );
  }
  if (history.rows.length > 0) {
    return (
      <div className="space-y-1 text-xs" data-testid="price-history">
        <Rows rows={history.rows} truckLinks={truckLinks} />
      </div>
    );
  }
  const pickedRows = picked?.rows ?? [];
  // Only reasons whose lots reached THIS reader's rows: a reason names
  // another client's goods, chosen from the presser's trucks.
  const reasons = pick && picked ? visibleReasons(pick, picked.reachedLotIds) : [];
  return (
    <div className="space-y-1.5 text-xs" data-testid="price-history">
      <p className="text-ink-500" data-testid="price-history-none">
        {t('priceHistoryNone')}
      </p>
      {pick ? (
        pickedRows.length > 0 ? (
          <>
            <Rows rows={pickedRows} truckLinks={truckLinks} />
            {reasons.length > 0 ? (
              <ul className="space-y-0.5 text-2xs text-ink-500" data-testid="price-history-ai-reasons">
                {reasons.map((r, i) => (
                  <li key={i} className="break-words">
                    🤖 {r.name}: {r.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="text-ink-500" data-testid="price-history-ai-none">
            🤖 {t('priceHistoryAiNone')}
          </p>
        )
      ) : (
        <SimilarAiButton lotId={lotId} batchId={batchId} />
      )}
    </div>
  );
}
