import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { salesManagerOptions } from '@/modules/platform/rbac/queries';
import { listSources } from '@/modules/wms/crm/service';
import { readAnalyticsFilters, readPeriod, salesAnalytics } from '@/modules/wms/crm/analytics';
import { hrefWith } from '@/components/list/board-filter';
import { PageHeader } from '@/components/ui/page';
import { stageClass } from '../../stage-color';

/**
 * The sales month on one screen (round 98, item 8: «dunyo standartlarida
 * qanday malumotlar tahlili bolsa hammasini hohlayman»), filterable by
 * everything a lead can be sliced by (his follow-up: «filterlarni maximalna
 * qoyish mumkun bolgan narsalarga qoyib ber, source sotuvchi va boshqalar»)
 * — manba, sotuvchi (incl. «Egasiz»), and the narx/kub/kg ranges the boards
 * already speak.
 *
 * Gated `crm.manage` like the arrivals ledger: this names every seller's
 * numbers side by side, which is a management view. `hodim` here is a LENS,
 * not a boundary — the viewer already sees everyone — unlike the boards,
 * where it is honored only under `crm.leads.view_all`.
 *
 * Two clocks, said in the header: «kelgan» counts by arrival day, «yopilgan»
 * by decision day (0076). The FILTERS apply to both clocks; the period must
 * not leak into the filter set (see AnalyticsFilters) or a lead that arrived
 * before the period and closed inside it vanishes from the decided numbers.
 */
export default async function SalesAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.manage')) redirect('/crm');
  const t = await getTranslations('crm');
  const tc = await getTranslations('common');

  const raw = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const period = readPeriod({ dan: first(raw.dan), gacha: first(raw.gacha) });
  const filters = readAnalyticsFilters(raw);

  const [data, sources, managerRows] = await Promise.all([
    salesAnalytics(period, filters),
    // Inactive sources INCLUDED: a retired source's history is exactly what
    // this page exists to read, and a select that cannot render the value in
    // the URL deletes it on the next submit (#171).
    listSources(true),
    salesManagerOptions(filters.owner !== 'none' ? filters.owner : undefined),
  ]);

  // The seller picker must be able to name HISTORY: salesManagerOptions is
  // active permission-holders, while the table's rows come from whoever
  // actually owned leads — a seller deactivated mid-year keeps a year of
  // numbers. The union of both is every name either half can print.
  const sellerOptions = new Map<string, string>();
  for (const row of managerRows) sellerOptions.set(row.id, row.fullName);
  for (const row of data.sellers) if (row.id) sellerOptions.set(row.id, row.name);

  const usd = (n: number) => `$${n.toLocaleString('en-US')}`;
  const peak = Math.max(1, ...data.perDay.map((d) => Math.max(d.fresh, d.won)));

  // Every link on this screen carries the whole state — a preset that drops
  // the manba filter reloads an unfiltered page under a chip still claiming
  // otherwise (#514, round 65's literal-links lesson). `carried` holds only
  // VALIDATED values serialized back, so garbage cannot walk URL to URL.
  const base = { dan: period.dan, gacha: period.gacha, ...filters.carried };

  const today = new Date();
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const daysAgo = (n: number) => new Date(today.getTime() - n * 86_400_000);
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const prevMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const prevMonthEnd = new Date(monthStart.getTime() - 86_400_000);
  const presets = [
    { label: t('period7'), dan: day(daysAgo(6)), gacha: day(today) },
    { label: t('period30'), dan: day(daysAgo(29)), gacha: day(today) },
    { label: t('periodMonth'), dan: day(monthStart), gacha: day(today) },
    { label: t('periodPrevMonth'), dan: day(prevMonthStart), gacha: day(prevMonthEnd) },
  ];

  // What each active filter is CALLED — the chips row keeps a closed fold
  // honest: numbers narrowed by an invisible filter get quoted onward.
  const sourceName = (id: string | undefined) =>
    id === 'none' ? '—' : (sources.find((s) => s.id === id)?.name ?? '?');
  const sellerName = (id: string | undefined) =>
    id === 'none' ? t('unowned') : (sellerOptions.get(id ?? '') ?? '?');
  const chips: { key: string; text: string }[] = [];
  if (filters.source) chips.push({ key: 'manba', text: `${t('source')}: ${sourceName(filters.source)}` });
  if (filters.owner) chips.push({ key: 'hodim', text: `${t('seller')}: ${sellerName(filters.owner)}` });
  for (const [key, label, min, max] of [
    ['narx', t('quotedAmount'), filters.amountMin, filters.amountMax],
    ['kub', t('quotedVolume'), filters.volMin, filters.volMax],
    ['kg', t('quotedWeight'), filters.kgMin, filters.kgMax],
  ] as const) {
    if (min !== undefined || max !== undefined) {
      const parts = [min !== undefined ? `≥${min}` : '', max !== undefined ? `≤${max}` : ''];
      chips.push({ key, text: `${label} ${parts.filter(Boolean).join(' ')}` });
    }
  }
  const chipHref = (key: string) =>
    hrefWith(base, key === 'narx' || key === 'kub' || key === 'kg'
      ? { [`${key}_min`]: undefined, [`${key}_max`]: undefined }
      : { [key]: undefined });

  const cells = [
    { key: 'fresh', value: data.totals.fresh, label: t('statFresh') },
    { key: 'won', value: data.totals.won, label: t('statWon'), good: true },
    { key: 'lost', value: data.totals.lost, label: t('statLost'), bad: data.totals.lost > 0 },
    { key: 'rate', value: `${data.totals.winRate}%`, label: t('statWinRate') },
    { key: 'usd', value: usd(data.totals.wonUsd), label: t('statWonUsd'), good: true },
    { key: 'cycle', value: data.totals.cycleDays, label: t('statCycle') },
    { key: 'open', value: data.totals.open, label: t('statOpen') },
  ];

  return (
    <div className="space-y-4">
      <PageHeader icon="report" title={t('analytics')} />

      {/* ONE GET form for the period AND the filters: two forms would each
          wipe the other's inputs on submit (#171). The advanced half folds —
          open whenever something in it is active, so a filter can never hide
          behind a closed fold (round 72's invisible-widening rule). */}
      <form className="card space-y-2" data-testid="period-form">
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1">
            <span className="label">{t('periodFrom')}</span>
            <input type="date" name="dan" defaultValue={period.dan} className="input !w-auto" />
          </label>
          <label className="space-y-1">
            <span className="label">{t('periodTo')}</span>
            <input type="date" name="gacha" defaultValue={period.gacha} className="input !w-auto" />
          </label>
          <button type="submit" className="btn-secondary">
            {t('periodShow')}
          </button>
          <span className="flex flex-wrap gap-1">
            {presets.map((preset) => (
              <Link
                key={preset.label}
                href={hrefWith(base, { dan: preset.dan, gacha: preset.gacha })}
                className="chip"
              >
                {preset.label}
              </Link>
            ))}
          </span>
        </div>

        <details open={filters.active > 0} data-testid="analytics-filters-fold">
          <summary className="cursor-pointer list-none text-sm font-semibold text-ink-700 marker:content-none">
            ⚲ {t('boardFilters')}
            {filters.active > 0 && <span className="chip chip-brand ml-1.5">{filters.active}</span>}
          </summary>
          <div className="grid gap-2 pt-2 sm:grid-cols-2 lg:grid-cols-3">
            <label className="space-y-1">
              <span className="text-2xs font-bold uppercase tracking-[0.06em] text-ink-500">
                {t('source')}
              </span>
              <select name="manba" defaultValue={filters.source ?? ''} className="input" data-testid="af-manba">
                <option value="">{t('all')}</option>
                <option value="none">—</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-2xs font-bold uppercase tracking-[0.06em] text-ink-500">
                {t('seller')}
              </span>
              <select name="hodim" defaultValue={filters.owner ?? ''} className="input" data-testid="af-hodim">
                <option value="">{t('all')}</option>
                <option value="none">{t('unowned')}</option>
                {[...sellerOptions.entries()].map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            {(
              [
                ['narx_min', 'narx_max', t('quotedAmount'), filters.amountMin, filters.amountMax],
                ['kub_min', 'kub_max', t('quotedVolume'), filters.volMin, filters.volMax],
                ['kg_min', 'kg_max', t('quotedWeight'), filters.kgMin, filters.kgMax],
              ] as const
            ).map(([nameMin, nameMax, label, vMin, vMax]) => (
              <div key={nameMin}>
                <span className="text-2xs font-bold uppercase tracking-[0.06em] text-ink-500">
                  {label}
                </span>
                {/* min-w-0 flex-1 on BOTH, or .input's intrinsic width takes
                    the row past 360px and mobile Chrome rescales the whole
                    page (#400, #419 — the BoardFilter range idiom verbatim). */}
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    inputMode="decimal"
                    name={nameMin}
                    defaultValue={vMin !== undefined ? String(vMin) : ''}
                    placeholder={t('filterMin')}
                    aria-label={`${label} ${t('filterMin')}`}
                    data-testid={`af-${nameMin}`}
                    className="input min-w-0 flex-1"
                  />
                  <span className="text-ink-400">–</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    name={nameMax}
                    defaultValue={vMax !== undefined ? String(vMax) : ''}
                    placeholder={t('filterMax')}
                    aria-label={`${label} ${t('filterMax')}`}
                    data-testid={`af-${nameMax}`}
                    className="input min-w-0 flex-1"
                  />
                </div>
              </div>
            ))}
          </div>
        </details>
      </form>

      {/* Active filters, echoed where they cannot hide; each chip removes
          its own filter, the last link clears the lot but keeps the period. */}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="analytics-chips">
          {chips.map((chip) => (
            <Link key={chip.key} href={chipHref(chip.key)} className="chip chip-brand">
              {chip.text} ✕
            </Link>
          ))}
          <Link
            href={hrefWith({ dan: period.dan, gacha: period.gacha }, {})}
            className="text-sm text-ink-500 underline"
            data-testid="analytics-clear"
          >
            {t('filterClear')}
          </Link>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7" data-testid="sales-pulse">
        {cells.map((cell) => (
          <div
            key={cell.key}
            data-testid={`sales-${cell.key}`}
            className={`card !p-3 ${cell.bad ? 'border-bad/30 bg-bad/10' : ''}`}
          >
            <p
              className={`truncate text-xl font-extrabold ${cell.bad ? 'text-bad' : cell.good ? 'text-good' : ''}`}
            >
              {cell.value}
            </p>
            <p className="text-xs text-ink-500">{cell.label}</p>
          </div>
        ))}
      </div>

      {/* Arrivals vs wins, per day — the vazifalar report's plain-div bars. */}
      {data.perDay.length > 0 && (
        <section className="card space-y-2">
          <h2 className="text-sm font-bold">{t('trend')}</h2>
          <div className="flex items-end gap-1 overflow-x-auto" data-testid="sales-trend">
            {data.perDay.map((d) => (
              <div key={d.day} className="flex min-w-4 flex-1 flex-col items-center gap-0.5">
                <div className="flex h-20 w-full items-end justify-center gap-0.5">
                  <div
                    title={`${d.day} · +${d.fresh}`}
                    className="w-1.5 rounded-t bg-warn/70"
                    style={{ height: `${(d.fresh / peak) * 100}%` }}
                  />
                  <div
                    title={`${d.day} · ✓${d.won}`}
                    className="w-1.5 rounded-t bg-good/70"
                    style={{ height: `${(d.won / peak) * 100}%` }}
                  />
                </div>
                <span className="text-[10px] text-ink-400">{d.day.slice(8)}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-ink-500">
            <span className="text-warn">▮</span> {t('statFresh')} ·{' '}
            <span className="text-good">▮</span> {t('statWon')}
          </p>
        </section>
      )}

      {/* Where the open work stands NOW — the filters apply, the period
          deliberately does not: «what is in hand» has no date range. */}
      <section className="card space-y-2">
        <h2 className="text-sm font-bold">{t('stageSnapshot')}</h2>
        <div className="space-y-1" data-testid="stage-snapshot">
          {data.stages.map((stage) => (
            <div key={stage.id} className="flex items-center gap-2 text-sm">
              <span
                className={`w-36 shrink-0 truncate rounded px-1.5 py-0.5 text-xs font-semibold ${stageClass(stage.color)}`}
              >
                {stage.name}
              </span>
              <span className="h-3 rounded bg-brand-500/60" style={{ width: `${stage.share}%` }} />
              <span className="font-mono text-xs tabular-nums">{stage.n}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="card space-y-2">
        <h2 className="text-sm font-bold">{t('bySource')}</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm" data-testid="source-table">
            <thead>
              <tr className="border-b border-line-strong text-left text-xs text-ink-500">
                <th className="p-2">{t('source')}</th>
                <th className="p-2 text-right">{t('statFresh')}</th>
                <th className="p-2 text-right">{t('statWon')}</th>
                <th className="p-2 text-right">{t('statLost')}</th>
                <th className="p-2 text-right">{t('statWinRate')}</th>
                <th className="p-2 text-right">{t('statWonUsd')}</th>
              </tr>
            </thead>
            <tbody>
              {data.sources.map((row) => {
                const key = row.id ?? 'none';
                const active = filters.source === key;
                return (
                  <tr key={key} className={`border-b border-line ${active ? 'bg-surface-sunken' : ''}`}>
                    {/* The row IS the filter picker — tapping a source narrows
                        the whole page to it, which beats hunting a select on a
                        phone and gives retired sources a door the select's
                        list alone could not. */}
                    <td className="p-2">
                      <Link
                        href={active ? chipHref('manba') : hrefWith(base, { manba: key })}
                        className={`underline decoration-dotted ${active ? 'font-bold' : ''}`}
                      >
                        {row.name}
                      </Link>
                    </td>
                    <td className="p-2 text-right font-semibold">{row.fresh}</td>
                    <td className="p-2 text-right text-good">{row.won}</td>
                    <td className="p-2 text-right text-ink-500">{row.lost}</td>
                    <td className="p-2 text-right">{row.winRate}%</td>
                    <td className="p-2 text-right font-mono tabular-nums">{usd(row.wonUsd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.sources.length === 0 && <p className="p-2 text-sm text-ink-500">{tc('empty')}</p>}
        </div>
      </section>

      <section className="card space-y-2">
        <h2 className="text-sm font-bold">{t('bySeller')}</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm" data-testid="seller-table">
            <thead>
              <tr className="border-b border-line-strong text-left text-xs text-ink-500">
                <th className="p-2">{t('seller')}</th>
                <th className="p-2 text-right">{t('statFresh')}</th>
                <th className="p-2 text-right">{t('statWon')}</th>
                <th className="p-2 text-right">{t('statLost')}</th>
                <th className="p-2 text-right">{t('statWonUsd')}</th>
                <th className="p-2 text-right">{t('statCycle')}</th>
                <th className="p-2 text-right">{t('statOpen')}</th>
              </tr>
            </thead>
            <tbody>
              {data.sellers.map((row) => {
                const key = row.id ?? 'none';
                const active = filters.owner === key;
                return (
                  <tr key={key} className={`border-b border-line ${active ? 'bg-surface-sunken' : ''}`}>
                    <td className="p-2">
                      <Link
                        href={active ? chipHref('hodim') : hrefWith(base, { hodim: key })}
                        className={`underline decoration-dotted ${active ? 'font-bold' : ''}`}
                      >
                        {row.id ? row.name : t('unowned')}
                      </Link>
                    </td>
                    <td className="p-2 text-right font-semibold">{row.fresh}</td>
                    <td className="p-2 text-right text-good">{row.won}</td>
                    <td className="p-2 text-right text-ink-500">{row.lost}</td>
                    <td className="p-2 text-right font-mono tabular-nums">{usd(row.wonUsd)}</td>
                    <td className="p-2 text-right">{row.cycleDays || '—'}</td>
                    <td className="p-2 text-right">{row.open}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.sellers.length === 0 && <p className="p-2 text-sm text-ink-500">{tc('empty')}</p>}
        </div>
      </section>

      {/* Why we lose — the list the owner asked for, counted. */}
      <section className="card space-y-2">
        <h2 className="text-sm font-bold">{t('lostReasonsTitle')}</h2>
        <div className="space-y-1" data-testid="lost-reasons">
          {data.lostReasons.map((row) => (
            <div key={row.reason} className="flex items-center gap-2 text-sm">
              <span className="w-40 shrink-0 truncate">{row.reason}</span>
              <span className="h-3 rounded bg-bad/50" style={{ width: `${row.share}%` }} />
              <span className="font-mono text-xs tabular-nums">
                {row.n} · {row.share}%
              </span>
            </div>
          ))}
          {data.lostReasons.length === 0 && <p className="text-sm text-ink-500">{tc('empty')}</p>}
        </div>
        <p className="text-xs text-ink-500">
          {t('lostReasonsHint')}{' '}
          <Link href="/crm/settings" className="text-brand-700 underline">
            {t('settings')}
          </Link>
        </p>
      </section>

      {/* The deals' half of the same period. Under a source filter there is
          no honest number here — a deal carries no source — so the block
          says that instead of printing company-wide figures that would be
          read as filtered. */}
      <section className="card space-y-1" data-testid="deals-block">
        <h2 className="text-sm font-bold">{t('dealsBlock')}</h2>
        {data.deals ? (
          <p className="text-sm">
            <span className="font-semibold text-good">{data.deals.won}</span> {t('statWon')} ·{' '}
            <span className="text-ink-500">{data.deals.lost}</span> {t('statLost')} ·{' '}
            {data.deals.winRate}% ·{' '}
            <span className="font-mono tabular-nums">{usd(data.deals.wonUsd)}</span> ·{' '}
            {data.deals.open} {t('statOpen')}
          </p>
        ) : (
          <p className="text-sm text-ink-500">{t('dealsNoSource')}</p>
        )}
      </section>
    </div>
  );
}
