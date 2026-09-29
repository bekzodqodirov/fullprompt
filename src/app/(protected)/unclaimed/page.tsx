import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader } from '@/components/ui/page';
import { hasNoWarehouse } from '@/modules/platform/rbac/scope';
import { unclaimedReport } from '@/modules/wms/reports/queries';

/**
 * Unclaimed pool (spec 6.7) — resolution actions arrive in M2.
 *
 * The dashboard's «egasiz yuk» row links here, so this page reads the SAME
 * list the row counts (`unclaimedReport` / `unclaimedSummary`): prixods with
 * cargo still to resolve — in a warehouse or on a truck, the road labelled
 * «yo'lda» (a prixod on the way is exactly the one whose owner the office
 * wants named before it lands). It was a fourth hand-written copy that listed
 * every unclaimed prixod ever confirmed, cartons returned to their sender
 * included, under a number that counted something else.
 */
export default async function UnclaimedPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('receipts');
  const tc = await getTranslations('common');
  const tu = await getTranslations('uncollected');
  const format = await getFormatter();

  // `warehouseScope`'s three answers, for a list that takes ids: a scoped
  // person with no warehouse reads NOTHING, never the whole company.
  const rows = hasNoWarehouse(actor)
    ? []
    : (await unclaimedReport(actor.warehouseScoped ? actor.warehouseIds : undefined))
        .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
        .slice(0, 100);

  return (
    <div className="space-y-4">
      <PageHeader icon="alert" title={t('unclaimedTitle')} />
      {rows.length === 0 && <p className="text-ink-500">{tc('empty')}</p>}
      <div className="space-y-2">
        {rows.map((row) => (
          <Link
            key={row.id}
            href={`/receipts/${row.id}`}
            className="card block !p-3 hover:bg-surface-sunken"
          >
            <div className="flex items-baseline gap-2">
              <span className="font-mono font-bold">{row.number}</span>
              {/* What the carton SAYS — a factory writes its own text code
                  there (DECISIONS #1224), and it is the only thing on this
                  row the person holding the carton can match. */}
              {row.marking && (
                <span
                  data-testid="unclaimed-marking"
                  className="min-w-0 truncate font-mono text-sm font-semibold text-orange-800"
                >
                  {row.marking}
                </span>
              )}
              <span className="ml-auto shrink-0 text-xs text-ink-500">
                {format.dateTime(new Date(row.receivedAt), { dateStyle: 'short' })}
              </span>
            </div>
            <p className="text-sm text-ink-700">
              {row.whCode} · {row.boxes} 📦
              {row.boxesOnRoad > 0 && (
                <span className="font-semibold text-warn" data-testid="unclaimed-on-road">
                  {' · 🚚 '}
                  {tu('onRoad', { n: row.boxesOnRoad })}
                </span>
              )}
              {row.sourceNote && ` · ${row.sourceNote}`}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
