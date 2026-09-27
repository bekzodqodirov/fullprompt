import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { SortTh, sortRows } from '@/components/sort-th';
import {
  JOURNAL_CAP,
  readJournalWindow,
  receiptsJournal,
  receiptsJournalTotals,
} from '@/modules/wms/reports/queries';
import { BackLink } from '@/components/back-link';
import { PageHeader } from '@/components/ui/page';
import { reportBaseIds, reportScope, warehouseOptions } from '@/modules/wms/reports/report-scope';

const SORTABLE = ['number', 'receivedAt', 'whCode', 'boxCount', 'kg'] as const;

/** Report §13.2: receipts journal (period, WH, operator). */
export default async function ReceiptsJournalPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; dir?: string; days?: string; from?: string; to?: string; ombor?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const allWh = actor.permissions.has('reports.all_warehouses');
  if (!allWh && !actor.permissions.has('reports.own_warehouse')) redirect('/');
  const t = await getTranslations('reports');
  const format = await getFormatter();
  const { sort, dir, days: rawDays, from, to, ombor } = await searchParams;
  // A range (the dashboard's «Qabul · bu oy» links one) or the last N days.
  const period = readJournalWindow({ from, to, days: rawDays });
  const days = typeof period === 'number' ? period : null;
  // The dashboard's scope rule (report-scope.ts, O10): both rules intersected,
  // and `?ombor=` only when it is one of THIS viewer's warehouses.
  const options = await warehouseOptions(reportBaseIds(actor));
  const scope = reportScope(actor, ombor, options);

  const [list, totals] = await Promise.all([
    receiptsJournal(period, scope.ids),
    receiptsJournalTotals(period, scope.ids),
  ]);
  const rows = sortRows(list, sort, dir, SORTABLE);
  // Only validated values travel on (#514): the window as it was read, the
  // warehouse only if it survived `reportScope`.
  const params: Record<string, string> =
    typeof period === 'number' ? { days: String(period) } : { from: period.from, to: period.to };
  if (scope.ombor) params.ombor = scope.ombor;
  const query = new URLSearchParams(params).toString();
  const presetHref = (d: number) =>
    `?${new URLSearchParams({ days: String(d), ...(scope.ombor ? { ombor: scope.ombor } : {}) }).toString()}`;
  // The select's GET form re-posts what it does not own (#171): the window,
  // and a sort the table would otherwise forget.
  const kept: Record<string, string> = { ...params };
  delete kept.ombor;
  if (sort && (SORTABLE as readonly string[]).includes(sort)) kept.sort = sort;
  if (dir === 'asc' || dir === 'desc') kept.dir = dir;

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-4xl">
      <BackLink href="/reports" label={t('title')} />
      <div className="flex flex-wrap items-baseline gap-2">
        <PageHeader icon="inbox" title={t('receiptsJournal')} />
        <span className="flex gap-1 text-sm">
          {[7, 30, 90].map((d) => (
            <Link
              key={d}
              href={presetHref(d)}
              className={`rounded px-2 py-0.5 font-semibold ${d === days ? 'bg-brand-600 text-white' : 'bg-surface-sunken'}`}
            >
              {d}
            </Link>
          ))}
        </span>
        <a href={`/api/reports/receipts-journal?${query}`} className="btn-secondary !min-h-9 ml-auto px-3 text-sm">
          ⬇️ XLSX
        </a>
      </div>
      {/* A choice only exists with two warehouses to choose between. The
          select shrinks (min-w-0 flex-1) instead of widening the row: a native
          select sizes to its longest option, and a row past 360 px rescales
          the whole phone page (#400). */}
      {options.length >= 2 && (
        <form method="get" className="flex items-center gap-2" data-testid="journal-ombor-form">
          {Object.entries(kept).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
            <span className="shrink-0 text-ink-500">{t('journalWarehouse')}</span>
            <select
              name="ombor"
              defaultValue={scope.ombor ?? ''}
              className="input-sm min-w-0 flex-1"
              data-testid="journal-ombor"
            >
              <option value="">{t('journalAllWarehouses')}</option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.code}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn-secondary !min-h-9 shrink-0 px-3 text-sm">
            {t('journalShow')}
          </button>
        </form>
      )}
      {/* The header is an aggregate over the whole period, never a sum of the
          capped list — and it says when the list below is only its newest part. */}
      <p className="flex flex-wrap gap-x-1 text-sm text-ink-700" data-testid="journal-totals">
        {typeof period !== 'number' && (
          <span className="font-mono text-ink-500">
            {period.from} — {period.to} ·
          </span>
        )}
        <span>{t('journalTotals', { receipts: totals.receipts, boxes: totals.boxes })}</span>
        <span className="font-mono tabular-nums">
          · {totals.m3.toLocaleString('en-US', { maximumFractionDigits: 2 })} m³ ·{' '}
          {totals.kg.toLocaleString('en-US', { maximumFractionDigits: 1 })} kg
        </span>
      </p>
      {list.length >= JOURNAL_CAP && (
        <p className="text-xs text-warn" data-testid="journal-capped">
          ⚠ {t('journalCapped', { n: JOURNAL_CAP })}
        </p>
      )}
      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead>
              <tr className="border-b border-line-strong bg-surface-sunken text-left text-xs uppercase text-ink-500">
                <SortTh label="№" field="number" sort={sort} dir={dir} params={params} />
                <SortTh label={t('date')} field="receivedAt" sort={sort} dir={dir} params={params} />
                <SortTh label="WH" field="whCode" sort={sort} dir={dir} params={params} />
                <th className="p-2">{t('client')}</th>
                <th className="p-2">{t('operator')}</th>
                <SortTh label="📦" field="boxCount" sort={sort} dir={dir} params={params} className="p-2 text-right" />
                <SortTh label="kg" field="kg" sort={sort} dir={dir} params={params} className="p-2 text-right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="p-2">
                    <Link href={`/receipts/${row.id}`} className="font-mono text-xs font-bold text-brand-700">
                      {row.number}
                    </Link>
                  </td>
                  <td className="p-2 text-xs">{format.dateTime(row.receivedAt, { dateStyle: 'short' })}</td>
                  <td className="p-2 font-mono font-bold">{row.whCode}</td>
                  <td className="p-2 font-mono font-extrabold text-brand-700">
                    {row.clientCode ?? row.marking ?? '?'}
                  </td>
                  <td className="max-w-36 truncate p-2 text-xs text-ink-700">{row.operator}</td>
                  <td className="p-2 text-right font-semibold">{row.boxCount}</td>
                  <td className="p-2 text-right">{row.kg}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <p className="p-4 text-sm text-ink-500">{t('noData')}</p>}
      </div>
    </div>
  );
}
