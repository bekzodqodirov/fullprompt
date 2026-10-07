'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { PriceSpread, type SpreadRow } from '@/components/charts/price-spread';
import { TableTwin } from '@/components/charts/table-twin';
import { num, unitPrice } from '@/components/charts/format';
import { basisLabel } from '@/modules/wms/calc/basis';
import type { BazaBasis } from '@/modules/wms/calc/pricing';
import type { ImportUnit } from '@/modules/wms/customs/import-parse';
import type { ImportStatsAnswer, UnitStats } from '@/modules/wms/customs/import-stats';
import {
  FEW,
  domainOf,
  type ExemplarKey,
  type PriceExemplar,
  type SeriesStats,
} from '@/modules/wms/customs/import-stats-math';

/**
 * «Narxlar statistikasi» — the customs file's own answer to «what does this
 * code usually declare at», above the list in the 📥 dialog (his C1-C6).
 *
 * What a person can DO here is the design: a 25/50/75 % chip opens the REAL
 * declaration standing at that price (name, date, sender, country), and only
 * «Tanlash» on that card fills the baza (C3) — through the same door as a
 * list pick, so the 📥 chip, the `baza_from_import` warning and the ✅ record
 * apply unchanged. A tap only NAMES; nothing is drafted by reading.
 *
 * It lives in the dialog's SCROLLING region and folds to one line while the
 * search box holds text: the search filters the LIST, and four hundred
 * pixels of statistics above it would hide every result (#922's own
 * complaint, «bazani qidirganda korinmay qolyabti»).
 *
 * No warning of any kind (C5 a): the VED's number is drawn as a position, in
 * ink.
 */

export type NamedSeries =
  | { state: 'loading' }
  | { state: 'short' }
  | { state: 'stale' }
  | { state: 'hidden' }
  | { state: 'ok'; series: Partial<Record<ImportUnit, SeriesStats>> };

export type StatsLoad = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; answer: ImportStatsAnswer };

type SeriesKey = 'all' | 'named' | 'weight';
const ROW_TESTID: Record<SeriesKey, string> = {
  all: 'calc-import-row-all',
  named: 'calc-import-row-named',
  weight: 'calc-import-row-weight',
};
const PCT_TESTID: Record<ExemplarKey, string> = {
  p25: 'calc-import-pct-25',
  p50: 'calc-import-pct-50',
  p75: 'calc-import-pct-75',
};
const PCT_LABEL: Record<ExemplarKey, string> = { p25: '25 %', p50: '50 %', p75: '75 %' };

export function BazaStats({
  stats,
  named,
  current,
  mode,
  onPick,
  collapsed,
  onExpand,
}: {
  stats: StatsLoad;
  named: NamedSeries;
  /** The row's baza on screen — for the marker only. */
  current: { usd: number; basis: BazaBasis } | null;
  mode: 'pick' | 'view';
  onPick: (row: { id: string; pricePerUnitUsd: number; basis: BazaBasis }) => void;
  collapsed: boolean;
  onExpand: () => void;
}) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const [activeUnit, setActiveUnit] = useState<ImportUnit | null>(null);
  const [open, setOpen] = useState<{ series: SeriesKey; key: ExemplarKey } | null>(null);
  const [fullName, setFullName] = useState(false);

  if (stats.state === 'ready') {
    const s = stats.answer.state;
    // The list already says «nothing imported» / «no code» in its own words.
    if (s === 'no_batch' || s === 'no_code') return null;
    if (s === 'ok' && stats.answer.units.length === 0) return null;
  }

  const answer = stats.state === 'ready' && stats.answer.state === 'ok' ? stats.answer : null;
  const unit: UnitStats | null = answer
    ? (answer.units.find((u) => u.unit === activeUnit) ?? answer.units[0] ?? null)
    : null;

  if (collapsed) {
    const p50 = unit && unit.all.n >= FEW ? unit.all.p50 : null;
    return (
      <div data-testid="calc-import-stats" className="shrink-0">
        <button
          type="button"
          className="flex min-h-11 w-full items-center rounded-xl border border-line px-3 text-left text-xs font-semibold text-ink-700 hover:bg-surface-sunken"
          data-testid="calc-import-stats-summary"
          onClick={onExpand}
        >
          {p50 !== null ? t('statsSummary', { p50: unitPrice(p50) }) : `${t('statsTitle')} ▸`}
        </button>
      </div>
    );
  }

  const shell = (body: ReactNode) => (
    <section data-testid="calc-import-stats" className="shrink-0 rounded-xl border border-line p-3">
      <h3 className="text-xs font-semibold text-ink-900">{t('statsTitle')}</h3>
      {body}
    </section>
  );

  if (stats.state === 'loading') return shell(<p className="mt-1 text-2xs text-ink-500">{tc('loading')}</p>);
  if (stats.state === 'failed' || stats.answer.state === 'behind') {
    return shell(
      <p className="mt-1 text-2xs text-warn" data-testid="calc-import-stats-failed">
        {t('statsFailed')}
      </p>,
    );
  }
  if (stats.answer.state === 'timeout') {
    return shell(
      <p className="mt-1 text-2xs text-warn" data-testid="calc-import-stats-timeout">
        {mode === 'view' ? t('statsTimeoutView') : t('statsTimeout')}
      </p>,
    );
  }
  if (!answer || !unit) return null;

  const perUnit = t('perUnit');
  const unitName = (u: UnitStats) => basisLabel(u.basis, perUnit);
  const namedStats: SeriesStats | null =
    named.state === 'ok' ? (named.series[unit.unit] ?? emptySeries()) : null;
  const weightStats = unit.weight !== null && unit.weight !== 'no_row_weight' ? unit.weight : null;

  // The series this tab can show, «Hammasi» first; a series with nothing in
  // it says so in words rather than drawing an empty row.
  const series: { key: SeriesKey; label: string; stats: SeriesStats }[] = [
    { key: 'all', label: t('statsAll'), stats: unit.all },
  ];
  if (namedStats && namedStats.n > 0) series.push({ key: 'named', label: t('statsNamed'), stats: namedStats });
  if (weightStats && weightStats.n > 0 && answer.perPieceKg !== null) {
    series.push({ key: 'weight', label: t('statsWeight', { kg: num(answer.perPieceKg, 3) }), stats: weightStats });
  }

  // The VED's own number, only on an axis it belongs to: a per-dona baza on
  // a per-kg axis is a false comparison, so it is said in words instead.
  const sameBasis = current !== null && current.basis === unit.basis;
  // The chart names each row by its TEXT (never a colour); the count is said
  // once, on the chips' own line below and in the table.
  const rows: SpreadRow[] = series.map((x) => ({ key: x.key, label: x.label, stats: x.stats }));
  const domain = unit.all.n > 0 ? domainOf(unit.all) : null;
  const clipped = domain !== null && (domain.clippedLow > 0 || domain.clippedHigh > 0);

  const openSeries = open ? series.find((x) => x.key === open.series) : undefined;
  const openExemplar: PriceExemplar | null = open && openSeries ? (openSeries.stats.exemplars[open.key] ?? null) : null;

  const cell = (v: number | null) => (v === null ? '—' : unitPrice(v));
  const quart = (x: SeriesStats, v: number | null) => (x.n < FEW ? '—' : cell(v));

  return shell(
    <>
      {answer.units.length > 1 ? (
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t('statsTitle')}>
          {answer.units.map((u) => (
            <button
              key={u.unit}
              type="button"
              data-testid="calc-import-unit-chip"
              aria-pressed={u.unit === unit.unit}
              onClick={() => {
                setActiveUnit(u.unit);
                setOpen(null);
              }}
              className={`min-h-11 rounded-lg border px-3 text-xs ${
                u.unit === unit.unit
                  ? 'border-brand-500 bg-brand-50 font-semibold text-brand-700'
                  : 'border-line text-ink-700'
              }`}
            >
              {t('statsUnitTab', { unit: unitName(u), n: u.all.n })}
            </button>
          ))}
        </div>
      ) : null}
      {!unit.pickable ? (
        <p className="mt-1">
          <span className="chip chip-warn" data-testid="calc-import-unit-conflict">
            {t('importConflict', { unit: unitName(unit), law: basisLabel(answer.lawUnit ?? '', perUnit) })}
          </span>
        </p>
      ) : !unit.matches ? (
        <p className="mt-1">
          <span className="chip chip-warn" data-testid="calc-import-unit-mismatch">
            {t('importUnitMismatch', { unit: unit.unit })}
          </span>
        </p>
      ) : null}

      <p className="mt-2 text-2xs text-ink-600" data-testid="calc-import-origin">
        {answer.filtered ? (
          <>
            {t('statsChina', { china: unit.origin.china })} · {t('statsOther', { other: unit.origin.other })}
            {unit.origin.unknown > 0 ? ` · ${t('statsUnknownCountry', { n: unit.origin.unknown })}` : ''}
          </>
        ) : (
          t('statsNoOrigin')
        )}
      </p>

      {unit.all.n === 0 ? (
        <p className="mt-2 text-2xs text-ink-500" data-testid="calc-import-stats-none">
          {t('statsNone')}
        </p>
      ) : (
        <>
          <div className="mt-2">
            <PriceSpread
              all={unit.all}
              rows={rows}
              marker={sameBasis ? { value: current.usd, label: t('statsYou', { price: unitPrice(current.usd) }) } : null}
              medianLabel={t('statsMedian')}
              oneValueLabel={t('statsOneValue')}
              count={(n) => t('statsN', { n })}
            />
          </div>
          {domain && domain.lo === domain.hi ? (
            <p className="mt-1 text-2xs text-ink-500">{t('statsOneValue')}</p>
          ) : null}
          {current !== null && !sameBasis ? (
            <p className="mt-1 text-2xs text-ink-500" data-testid="calc-import-you-other">
              {t('statsYouOtherUnit', {
                price: unitPrice(current.usd),
                basis: basisLabel(current.basis, perUnit),
                unit: unitName(unit),
              })}
            </p>
          ) : null}
          {unit.all.n < FEW ? (
            <p className="mt-1 text-2xs text-ink-500" data-testid="calc-import-stats-few">
              {mode === 'view' ? t('statsFewView', { n: unit.all.n }) : t('statsFew', { n: unit.all.n })}
            </p>
          ) : null}

          <div className="mt-2 space-y-2">
            {series.map((x) => (
              <div key={x.key} data-testid={ROW_TESTID[x.key]}>
                <p className="text-2xs text-ink-700">
                  <span className="font-semibold">{x.label}</span> · {t('statsN', { n: x.stats.n })}
                </p>
                {x.stats.n >= FEW ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(['p25', 'p50', 'p75'] as const).map((key) => {
                      const value = x.stats[key];
                      const pressed = open?.series === x.key && open.key === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          data-testid={PCT_TESTID[key]}
                          aria-pressed={pressed}
                          disabled={value === null || x.stats.exemplars[key] === null}
                          // A tap NAMES the declaration and drafts nothing (C3).
                          onClick={() => {
                            setFullName(false);
                            setOpen(pressed ? null : { series: x.key, key });
                          }}
                          className={`min-h-11 rounded-lg border px-2 text-xs tabular-nums disabled:opacity-50 ${
                            pressed
                              ? 'border-ink-900 bg-surface-sunken font-semibold text-ink-900'
                              : 'border-line text-ink-700'
                          } ${key === 'p50' ? 'font-semibold' : ''}`}
                        >
                          {PCT_LABEL[key]} · {value === null ? '—' : unitPrice(value)}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {open?.series === x.key && openExemplar ? (
                  <div
                    className="mt-2 rounded-xl border border-line-strong bg-surface-sunken p-2"
                    data-testid="calc-import-exemplar"
                  >
                    {/* No `block` beside the clamp: `display` is emitted after
                        `line-clamp`, so it would win (import-baza-dialog's note). */}
                    <p
                      className={`text-xs text-ink-900 ${fullName ? 'break-words' : 'line-clamp-3 break-words'}`}
                      title={openExemplar.name}
                    >
                      {openExemplar.name}
                    </p>
                    {openExemplar.name.length > 160 ? (
                      <button
                        type="button"
                        className="text-2xs text-brand-600"
                        onClick={() => setFullName((v) => !v)}
                      >
                        {fullName ? t('importNameLess') : t('importNameMore')}
                      </button>
                    ) : null}
                    <p className="mt-0.5 text-2xs text-ink-500">
                      {[
                        openExemplar.declaredAt,
                        openExemplar.sender,
                        openExemplar.originCountry,
                        openExemplar.weightPerUnitKg !== null
                          ? `${openExemplar.weightPerUnitKg} kg/${perUnit}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    <p className="mt-0.5 font-mono text-sm tabular-nums text-ink-900">
                      ${openExemplar.pricePerUnitUsd} / {unitName(unit)}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {mode === 'pick' ? (
                        <button
                          type="button"
                          className="btn-primary !min-h-11"
                          data-testid="calc-import-exemplar-pick"
                          disabled={!unit.pickable}
                          // The ONE place a statistic becomes a draft: a pick of
                          // this real row, exactly as a list pick (C3).
                          onClick={() =>
                            onPick({
                              id: openExemplar.id,
                              pricePerUnitUsd: openExemplar.pricePerUnitUsd,
                              basis: unit.basis,
                            })
                          }
                        >
                          {t('statsPick')}
                        </button>
                      ) : (
                        <span className="text-2xs text-ink-500" data-testid="calc-import-exemplar-viewonly">
                          {t('statsPickPhone')}
                        </span>
                      )}
                      <button type="button" className="btn-ghost !min-h-11" onClick={() => setOpen(null)}>
                        {t('importClose')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </>
      )}

      {named.state !== 'ok' && named.state !== 'hidden' ? (
        <p className="mt-2 text-2xs text-ink-500" data-testid="calc-import-named-state">
          {named.state === 'loading'
            ? t('statsNamedLoading')
            : named.state === 'short'
              ? t('statsNamedShort')
              : t('statsNamedStale')}
        </p>
      ) : namedStats && namedStats.n === 0 ? (
        <p className="mt-2 text-2xs text-ink-500" data-testid="calc-import-named-state">
          {t('statsNamedNone')}
        </p>
      ) : null}

      {unit.weight === 'no_row_weight' ? (
        <p className="mt-1 text-2xs text-ink-500" data-testid="calc-import-weight-state">
          {t('statsWeightNoRow')}
        </p>
      ) : weightStats && weightStats.n === 0 ? (
        <p className="mt-1 text-2xs text-ink-500" data-testid="calc-import-weight-state">
          {t('statsWeightNone')}
        </p>
      ) : null}

      <p className="mt-2 text-2xs text-ink-600" data-testid="calc-import-prev">
        {unit.prev === null
          ? t('statsPrevMissing')
          : unit.prev.filtered !== answer.filtered
            ? t('statsPrevScope')
            : unit.prev.n === 0 || unit.prev.p50 === null
              ? t('statsPrevNone')
              : t('statsPrev', {
                  period: answer.prevPeriod ?? '—',
                  p50: unitPrice(unit.prev.p50),
                  n: unit.prev.n,
                })}
      </p>

      {unit.all.n > 0 && unit.all.min !== null && unit.all.max !== null ? (
        <p className="mt-1 text-2xs text-ink-500" data-testid="calc-import-range">
          {t('statsRange', { min: unitPrice(unit.all.min), max: unitPrice(unit.all.max) })}
        </p>
      ) : null}

      {unit.all.n > 0 ? (
        <TableTwin
          testid="calc-import-table"
          summary={clipped ? `${t('statsTable')} — ${t('statsClipped')}` : t('statsTable')}
          head={['', ...series.map((x) => x.label)]}
          rows={[
            [t('statsColN'), ...series.map((x) => String(x.stats.n))],
            [t('statsColMin'), ...series.map((x) => cell(x.stats.min))],
            [t('statsColP25'), ...series.map((x) => quart(x.stats, x.stats.p25))],
            [t('statsColP50'), ...series.map((x) => quart(x.stats, x.stats.p50))],
            [t('statsColP75'), ...series.map((x) => quart(x.stats, x.stats.p75))],
            [t('statsColMax'), ...series.map((x) => cell(x.stats.max))],
            [
              t('statsColPrev'),
              ...series.map((x) =>
                x.key === 'all' && unit.prev && unit.prev.filtered === answer.filtered ? cell(unit.prev.p50) : '—',
              ),
            ],
          ]}
        />
      ) : null}
    </>,
  );
}

function emptySeries(): SeriesStats {
  return {
    n: 0,
    min: null,
    max: null,
    p25: null,
    p50: null,
    p75: null,
    ladder: null,
    prices: null,
    exemplars: { p25: null, p50: null, p75: null },
  };
}
