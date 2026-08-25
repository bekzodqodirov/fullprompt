import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { WarehouseFillRow } from '@/modules/wms/reports/queries';

/**
 * «Qaysi sklad qanchalik to'lgan, va eng qari yuk necha kun yotibdi» — one row
 * per warehouse, drawn the same way on the analyst dashboard and on the
 * owner's own home (owner, 2026-08-25).
 *
 * Three things the shape has to get right:
 *
 *  - a warehouse with NO capacity gets no bar and says so, with a link to the
 *    form where the number is typed. Every one of his nine warehouses is in
 *    that state today, which is why the older fill card has never rendered in
 *    production — a feature that silently shows nothing reads as broken.
 *  - the age is labelled «shu skladda» on purpose. Three other surfaces
 *    answer «how many days» from the receipt date, and for cargo that crossed
 *    a border the two numbers differ by the whole China→Uzbekistan leg; an
 *    unlabelled fourth clock would look like one of them contradicting itself.
 *  - the colour classes are LITERAL (Tailwind compiles what it can see), and
 *    every value is nowrap while the label truncates — a row wider than 360px
 *    rescales the whole page (#400).
 */
const BAR: Record<'ok' | 'warn' | 'bad', string> = {
  ok: 'bg-good',
  warn: 'bg-warn',
  bad: 'bg-bad',
};
const INK: Record<'ok' | 'warn' | 'bad', string> = {
  ok: 'text-ink-700',
  warn: 'text-warn',
  bad: 'text-bad',
};

function fillTone(pct: number): 'ok' | 'warn' | 'bad' {
  return pct >= 80 ? 'bad' : pct >= 60 ? 'warn' : 'ok';
}

/** The owner's own scale: a month is a question, three months is a problem. */
function ageTone(days: number, staleDays: number): 'ok' | 'warn' | 'bad' {
  if (days >= staleDays * 3) return 'bad';
  if (days >= staleDays) return 'warn';
  return 'ok';
}

export async function WarehouseFillRows({
  rows,
  staleDays,
  canEditCapacity,
}: {
  rows: WarehouseFillRow[];
  staleDays: number;
  /** Only somebody who can open the warehouse form is offered the link. */
  canEditCapacity: boolean;
}) {
  const t = await getTranslations('adminHome');
  if (rows.length === 0) return <p className="text-xs text-ink-500">—</p>;

  return (
    <div className="space-y-1.5" data-testid="wh-fill">
      {rows.map((row) => {
        const tone = row.pct === null ? 'ok' : fillTone(row.pct);
        const age = row.oldestDays === null ? null : ageTone(row.oldestDays, staleDays);
        return (
          <div key={row.code} className="flex items-center gap-2 text-xs" data-testid="wh-fill-row">
            <span className="w-14 shrink-0 font-mono text-sm font-extrabold">{row.code}</span>
            {row.pct === null ? (
              <span className="min-w-0 flex-1 truncate text-ink-500">
                {canEditCapacity ? (
                  <Link href={`/admin/warehouses/${row.id}`} className="underline">
                    {t('fillNoCapacity')}
                  </Link>
                ) : (
                  t('fillNoCapacity')
                )}
              </span>
            ) : (
              <div className="h-3 min-w-0 flex-1 overflow-hidden rounded bg-surface-sunken">
                <div
                  className={`h-full ${BAR[tone]}`}
                  style={{ width: `${Math.min(100, Math.max(2, row.pct))}%` }}
                />
              </div>
            )}
            <span className={`shrink-0 whitespace-nowrap font-mono font-bold ${INK[tone]}`}>
              {row.occupiedM3} m³
              {row.pct !== null ? ` · ${row.pct}%` : ''}
            </span>
            {age && row.oldestDays !== null && (
              <span
                className={`shrink-0 whitespace-nowrap font-mono ${INK[age]}`}
                title={t('oldestTitle')}
                data-testid="wh-fill-age"
              >
                🕓 {row.oldestDays} {t('daysShort')}
                {row.staleCount > 0 ? ` (${row.staleCount})` : ''}
              </span>
            )}
          </div>
        );
      })}
      <p className="text-2xs text-ink-500">{t('oldestNote', { days: staleDays })}</p>
    </div>
  );
}
