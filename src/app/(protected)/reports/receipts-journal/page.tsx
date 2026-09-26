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

const SORTABLE = ['number', 'receivedAt', 'whCode', 'boxCount', 'kg'] as const;

/** Report §13.2: receipts journal (period, WH, operator). */
export default async function ReceiptsJournalPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; dir?: string; days?: string; from?: string; to?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const allWh = actor.permissions.has('reports.all_warehouses');
  if (!allWh && !actor.permissions.has('reports.own_warehouse')) redirect('/');
  const t = await getTranslations('reports');
  const format = await getFormatter();
  const { sort, dir, days: rawDays, from, to } = await searchParams;
  // A range (the dashboard's «Qabul · bu oy» links one) or the last N days.
  const period = readJournalWindow({ from, to, days: rawDays });
  const days = typeof period === 'number' ? period : null;
  const scope = allWh ? undefined : actor.warehouseIds;

  const [list, totals] = await Promise.all([receiptsJournal(period, scope), receiptsJournalTotals(period, scope)]);
  const rows = sortRows(list, sort, dir, SORTABLE);
  const params: Record<string, string> =
    typeof period === 'number' ? { days: String(period) } : { from: period.from, to: period.to };
  const query = new URLSearchParams(params).toString();

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-4xl">
      <BackLink href="/reports" label={t('title')} />
      <div className="flex flex-wrap items-baseline gap-2">
        <PageHeader icon="inbox" title={t('receiptsJournal')} />
        <span className="flex gap-1 text-sm">
          {[7, 30, 90].map((d) => (
            <Link
              key={d}
              href={`?days=${d}`}
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
