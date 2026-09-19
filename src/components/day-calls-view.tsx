import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { DayCalls } from '@/modules/wms/crm/day';
import type { FollowUp } from '@/modules/wms/crm/service';
import { FollowUpRow } from './follow-up-row';

/**
 * The call list, drawn once for both day screens.
 *
 * `/bugun` and `/crm/today` carry the same title, answer the same question
 * and are reached from different menus — the seller's home links to the
 * second — so the owner's complaint («adminda hamma odamniki yig'ilib turib
 * qolgan») lived on BOTH and fixing one would have left it alive one tab
 * over. One data module (`dayCalls`) and one view; the pages keep their own
 * surroundings.
 */

function rowHref(row: FollowUp): string {
  return row.kind === 'lead' ? `/crm/leads/${row.id}` : `/admin/clients/${row.id}`;
}

function Rows({ rows }: { rows: FollowUp[] }) {
  return (
    <>
      {rows.map((row) => (
        <FollowUpRow
          key={`${row.kind}-${row.id}`}
          kind={row.kind}
          id={row.id}
          href={rowHref(row)}
          title={row.title}
          dueOn={row.dueOn}
          note={row.note}
        />
      ))}
    </>
  );
}

export async function DayCallsView({
  calls,
  basePath,
  showOthers,
}: {
  calls: DayCalls;
  /** Which screen we are on — the «Hammasi» door comes back to it. */
  basePath: string;
  showOthers: boolean;
}) {
  const t = await getTranslations('crm');
  const nothing =
    calls.mine.length + calls.stale.length === 0 && (!showOthers || calls.others.length === 0);

  return (
    <section className="space-y-2" data-testid="day-followups">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="section-title">
          📞 {t('dayMine')} · {calls.mine.length}
        </h2>
        {/**
         * The door to everybody's, and it prints its size whether or not it is
         * open (#513: the number and the rows come off the same query, so the
         * button cannot promise 187 and show 12). Only drawn for someone who
         * may see them — for a seller there is nothing behind it.
         */}
        {calls.seesAll && calls.othersCount > 0 && (
          <Link
            href={showOthers ? basePath : `${basePath}?hammasi=1`}
            className="ml-auto text-xs font-semibold text-brand-700 underline"
            data-testid="day-all-toggle"
          >
            {showOthers ? `← ${t('dayBack')}` : `${t('dayAll')} · ${calls.othersCount}`}
          </Link>
        )}
      </div>

      {nothing && <p className="card text-sm text-ink-500">{t('nothingToday')}</p>}
      <Rows rows={calls.mine} />

      {/**
       * His 4.2a: a week-old call is a backlog and must not sit on top of
       * today's work — and must not vanish either, which is his standing rule
       * about late work. One line, open in one tap, counted honestly.
       */}
      {calls.stale.length > 0 && (
        <details className="card !p-3" data-testid="day-stale">
          <summary className="cursor-pointer text-sm font-semibold text-warn">
            ⚠️ {t('dayStale', { n: calls.stale.length })}
          </summary>
          <div className="mt-2 space-y-2">
            <Rows rows={calls.stale} />
          </div>
        </details>
      )}

      {/**
       * «hammanikini korganimda yegma bolim bolib» — his own words. Folded by
       * seller, biggest pile first, closed until pressed: an admin opening
       * this wants to see WHO is behind, not to read a hundred rows.
       */}
      {showOthers && calls.others.length > 0 && (
        <div className="space-y-2 pt-1" data-testid="day-others">
          <h2 className="section-title">👥 {t('dayOthers')}</h2>
          {calls.others.map((section) => (
            <details key={section.ownerId} className="card !p-3" data-testid="day-seller">
              <summary className="cursor-pointer font-semibold">
                {section.name} · {section.rows.length}
              </summary>
              <div className="mt-2 space-y-2">
                <Rows rows={section.rows} />
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
