import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { readPeriod, salesAnalytics } from '@/modules/wms/crm/analytics';
import { PageHeader } from '@/components/ui/page';
import { stageClass } from '../../stage-color';

/**
 * The sales month on one screen (round 98, item 8: «dunyo standartlarida
 * qanday malumotlar tahlili bolsa hammasini hohlayman»).
 *
 * Gated `crm.manage` like the arrivals ledger: this names every seller's
 * numbers side by side, which is a management view. Widening it to sellers
 * (own column only) is a stated, reversible change away.
 *
 * Two clocks, said in the header: «kelgan» counts by arrival day, «yopilgan»
 * by decision day (0076). The tables answer the four questions a sales
 * report is FOR anywhere: is the pipe filling, are we winning what we
 * decide, who sells, and why do we lose.
 */
export default async function SalesAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ dan?: string; gacha?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.manage')) redirect('/crm');
  const t = await getTranslations('crm');
  const tc = await getTranslations('common');

  const params = await searchParams;
  const period = readPeriod(params);
  const data = await salesAnalytics(period);

  const peak = Math.max(1, ...data.perDay.map((d) => Math.max(d.fresh, d.won)));
  const usd = (n: number) => `$${n.toLocaleString('en-US')}`;

  // Preset links are plain GETs — the address bar is the filter (round 57).
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

      {/* The period: two date boxes and the four spans everybody actually
          asks for. GET, so a chosen period is a shareable address (#490). */}
      <form className="card flex flex-wrap items-end gap-2" data-testid="period-form">
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
              href={`/crm/tahlil?dan=${preset.dan}&gacha=${preset.gacha}`}
              className="chip"
            >
              {preset.label}
            </Link>
          ))}
        </span>
      </form>

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

      {/* Where the open work stands NOW — a snapshot, deliberately outside
          the period: «what is in hand» has no date range. */}
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
              {data.sources.map((row) => (
                <tr key={row.name} className="border-b border-line">
                  <td className="p-2">{row.name}</td>
                  <td className="p-2 text-right font-semibold">{row.fresh}</td>
                  <td className="p-2 text-right text-good">{row.won}</td>
                  <td className="p-2 text-right text-ink-500">{row.lost}</td>
                  <td className="p-2 text-right">{row.winRate}%</td>
                  <td className="p-2 text-right font-mono tabular-nums">{usd(row.wonUsd)}</td>
                </tr>
              ))}
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
              {data.sellers.map((row) => (
                <tr key={row.name} className="border-b border-line">
                  <td className="p-2">{row.name}</td>
                  <td className="p-2 text-right font-semibold">{row.fresh}</td>
                  <td className="p-2 text-right text-good">{row.won}</td>
                  <td className="p-2 text-right text-ink-500">{row.lost}</td>
                  <td className="p-2 text-right font-mono tabular-nums">{usd(row.wonUsd)}</td>
                  <td className="p-2 text-right">{row.cycleDays || '—'}</td>
                  <td className="p-2 text-right">{row.open}</td>
                </tr>
              ))}
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

      {/* The deals' half of the same period. */}
      <section className="card space-y-1" data-testid="deals-block">
        <h2 className="text-sm font-bold">{t('dealsBlock')}</h2>
        <p className="text-sm">
          <span className="font-semibold text-good">{data.deals.won}</span> {t('statWon')} ·{' '}
          <span className="text-ink-500">{data.deals.lost}</span> {t('statLost')} ·{' '}
          {data.deals.winRate}% · <span className="font-mono tabular-nums">{usd(data.deals.wonUsd)}</span> ·{' '}
          {data.deals.open} {t('statOpen')}
        </p>
      </section>
    </div>
  );
}
