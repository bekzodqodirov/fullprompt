import { getFormatter, getTranslations } from 'next-intl/server';
import { lastQuotesByCode, type LastQuote } from '@/modules/wms/calc/history';
import { priceBookForCodes } from '@/modules/wms/calc/dictionaries';
import { SECTION_LABELS } from '@/modules/wms/calc/labels';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { tashkentDay } from '@/modules/platform/time/tashkent';

/**
 * «Oxirgi narxlar» — what these codes were quoted at before, beside the
 * calculation being made now (docs/VED.md phase C, law 10).
 *
 * It sits in the workspace and not only on its own screen because that is
 * where the question is asked: the VED types a baza, and «what did we charge
 * last time» is the check on it. Both reads are ONE query each over every
 * code on the screen, never one per group (#432).
 *
 * Every figure carries its SECTION. `totalsFor` zeroes the parts a section
 * does not have, so a per-cube number is freight alone on a yolkira quote and
 * the whole job on a podklyuch one; printed unlabelled they would read as one
 * series and compare three different services.
 */
export async function LastQuotes({
  codes,
  requestId,
}: {
  codes: string[];
  requestId: string;
}) {
  const list = [...new Set(codes.map((c) => c.trim()))].filter(Boolean);
  if (list.length === 0) return null;

  const today = tashkentDay();
  let quotes = new Map<string, LastQuote[]>();
  let book: Awaited<ReturnType<typeof priceBookForCodes>> = new Map();
  try {
    [quotes, book] = await Promise.all([
      // FIVE, the agreed number (law 10: «beside the last 5 real quotes») —
      // the whole-module audit caught this shipped as 3 with no decision
      // recording the shrink.
      lastQuotesByCode(list, 5),
      priceBookForCodes(list, today),
    ]);
  } catch (err) {
    // 0087's table. On deploy morning the workspace must still price cargo.
    if (!isServerBehind(err)) throw err;
    logger.error({ err, requestId }, '[calc] last quotes: server behind');
    return null;
  }

  const shown = list.filter((c) => (quotes.get(c)?.length ?? 0) > 0 || book.has(c));
  if (shown.length === 0) return null;

  const t = await getTranslations('calc');
  const format = await getFormatter();

  return (
    <section className="card !p-3" data-testid="calc-last-quotes">
      <p className="text-2xs uppercase text-ink-500">{t('lastQuotes')}</p>
      <ul className="mt-1 space-y-2">
        {shown.map((code) => {
          const price = book.get(code);
          const rows = (quotes.get(code) ?? []).filter((q) => q.requestId !== requestId);
          return (
            <li key={code} data-testid="last-quote-code">
              <p className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="font-mono font-semibold tabular-nums">{code}</span>
                {price ? (
                  <span className="chip chip-brand" data-testid="last-quote-book">
                    ${price.priceUsd} / {price.unit === 'kg' ? t('unitKg') : t('unitM3')}
                  </span>
                ) : null}
                {/* A NEW TAB, and a plain anchor: the items table's drafts are client
                    state guarded only by `beforeunload`, which a client-side
                    navigation does not fire — a same-tab link would silently
                    throw away every unsaved cell (the channel round, F10 a). */}
                <a
                  className="text-2xs text-brand-700"
                  href={`/hisoblash/narxlar?kod=${encodeURIComponent(code)}`}
                  target="_blank"
                  rel="noopener"
                  data-testid="last-quote-more"
                >
                  {t('historyTitle')} →
                </a>
              </p>
              {rows.length > 0 ? (
                <ul className="text-2xs text-ink-600">
                  {rows.map((q) => (
                    <li key={q.versionId} className="flex flex-wrap gap-2">
                      {/* F10 a: the earlier calculation, one tap away for the VED who
                          seals a repeat fast — in a NEW tab for the same reason as
                          «narxlar» above. */}
                      <a
                        href={`/hisoblash/${q.requestId}`}
                        target="_blank"
                        rel="noopener"
                        className="text-brand-700 underline"
                        data-testid="last-quote-open"
                      >
                        {format.dateTime(q.sealedAt, { dateStyle: 'short' })}
                      </a>
                      <span className="chip chip-neutral">
                        {t(SECTION_LABELS[q.section] as 'sections.podklyuch')}
                      </span>
                      <span className="font-mono tabular-nums">${q.totalUsd.toFixed(2)}</span>
                      {q.perM3Usd !== null ? (
                        <span className="font-mono tabular-nums">
                          ${q.perM3Usd.toFixed(2)}/m³
                        </span>
                      ) : null}
                      {q.perKgUsd !== null ? (
                        <span className="font-mono tabular-nums">
                          ${q.perKgUsd.toFixed(2)}/kg
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
