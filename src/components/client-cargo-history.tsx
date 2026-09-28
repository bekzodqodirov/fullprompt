import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { groupDigits } from '@/modules/platform/telegram/format';
import type { IssuedHandover } from '@/modules/wms/client-cabinet/service';
import { pushLotName } from '@/modules/wms/notices/client-text';

/**
 * «Topshirilgan» — what this client has already collected, one block per
 * handover, the same list the client reads in the Mini App (`issuedHandovers`,
 * whose wire shape does not move) with the office's two additions: the truck
 * codes are links where the truck card admits the reader, and «Akt» is drawn
 * where the act's own door does (`issue/act-door.ts` — the route,
 * the attachment gate and this link ask one function).
 *
 * The window is the Mini App's 90 days with a «1 yil» toggle; «oxirgi 60 ta»
 * is printed only when the cap really cut the list (#913).
 */
export async function ClientCargoHistory({
  rows,
  capped,
  cap,
  days,
  hrefs,
  actOpen,
  legTruck,
}: {
  rows: readonly IssuedHandover[];
  capped: boolean;
  cap: number;
  days: number;
  hrefs: { short: string; year: string };
  /** Handovers whose act this reader may open. */
  actOpen: ReadonlySet<string>;
  /** A leg's truck id by its code, only where the truck card admits the reader. */
  legTruck: ReadonlyMap<string, string>;
}) {
  const t = await getTranslations('yuklar');
  const format = await getFormatter();
  const day = (iso: string | null) => (iso ? format.dateTime(new Date(iso), { dateStyle: 'short' }) : '—');
  const year = days > 90;

  return (
    <section id="topshirilgan" className="card scroll-mt-20 space-y-3 !p-3" data-testid="yuklar-history">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-bold">{t('history')}</h2>
        <nav className="flex gap-1" aria-label={t('history')}>
          <Link
            href={hrefs.short}
            aria-current={year ? undefined : 'true'}
            className={year ? 'chip-neutral' : 'chip-brand'}
            data-testid="yuklar-history-90"
          >
            {t('historyDays', { days: 90 })}
          </Link>
          <Link
            href={hrefs.year}
            aria-current={year ? 'true' : undefined}
            className={year ? 'chip-brand' : 'chip-neutral'}
            data-testid="yuklar-history-365"
          >
            {t('historyYear')}
          </Link>
        </nav>
        {capped && (
          <span className="text-xs text-warn" data-testid="yuklar-history-capped">
            {t('historyCapped', { n: cap })}
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-ink-500" data-testid="yuklar-history-empty">
          {t('historyEmpty')}
        </p>
      ) : (
        <ol className="space-y-3">
          {rows.map((h) => (
            <li key={h.id} className="space-y-1 border-b border-line pb-3 text-sm last:border-0 last:pb-0" data-testid="yuklar-handover">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <b className="whitespace-nowrap">{day(h.issuedAt)}</b>
                <span className="text-ink-700">🏭 {h.place}</span>
                {actOpen.has(h.id) && (
                  <a
                    href={`/api/handovers/${h.id}/act`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-brand-700 underline"
                    data-testid="yuklar-act"
                  >
                    📄 {t('act')}
                  </a>
                )}
              </p>
              <p className="text-xs text-ink-500 [overflow-wrap:anywhere]">
                {t('receiver')}: <span className="text-ink-700">{h.receiver}</span> · {t('issuedBy')}:{' '}
                <span className="text-ink-700">{h.issuedBy}</span>
              </p>
              <ul className="space-y-0.5">
                {h.lots.map((lot) => (
                  <li key={lot.lotId} className="flex flex-wrap gap-x-1">
                    <span className="[overflow-wrap:anywhere]">
                      {lot.letter && <span className="font-mono">{lot.letter} · </span>}
                      {pushLotName(lot.productNameRu, lot.productNameZh)}
                    </span>
                    <span className="flex flex-wrap gap-x-1 font-mono tabular-nums text-ink-700">
                      <span className="whitespace-nowrap">· {groupDigits(lot.n)} 📦</span>
                      <span className="whitespace-nowrap">· {groupDigits(lot.weightKg)} kg</span>
                      <span className="whitespace-nowrap">· {groupDigits(lot.volumeM3)} m³</span>
                    </span>
                  </li>
                ))}
              </ul>
              {h.legs.length > 0 && (
                <ul className="space-y-0.5 text-xs text-ink-500" data-testid="yuklar-legs">
                  {h.legs.map((leg) => {
                    const id = legTruck.get(leg.batchCode);
                    return (
                      <li key={leg.batchCode} className="flex flex-wrap gap-x-1">
                        <span>🚚</span>
                        {id ? (
                          <Link
                            href={`/batches/${id}`}
                            className="font-mono text-brand-700 underline"
                            data-testid="yuklar-leg-truck"
                          >
                            {leg.batchCode}
                          </Link>
                        ) : (
                          <span className="font-mono">{leg.batchCode}</span>
                        )}
                        <span>
                          ({leg.fromPlace} → {leg.toPlace})
                        </span>
                        <span className="whitespace-nowrap">
                          · {t('departed')} {day(leg.departedAt)}
                        </span>
                        <span className="whitespace-nowrap">
                          · {t('arrived')} {day(leg.arrivedAt)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
