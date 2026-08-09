import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { recentIntakes } from '@/modules/wms/crm/inbound';
import { PageHeader } from '@/components/ui/page';
import { MetaLine } from '@/components/board-meta';

/**
 * Everything an advert sent us, including what it did NOT turn into.
 *
 * This is the screen `lead_intakes` exists for. The funnel can only show
 * leads, so the day an advert produces nothing it looks exactly like the day
 * nobody clicked — and the difference between «no enquiries» and «twenty
 * enquiries that were all the same number» is the difference between a bad
 * campaign and a broken form. Every arrival is here with what became of it.
 *
 * Gated on `crm.manage`, the same door as the funnel's own settings: the
 * ledger names people who are not leads and not clients, and reading it is a
 * supervision job, not a selling one.
 */

const OUTCOME_CLASS: Record<string, string> = {
  created: 'chip-good',
  joined: 'chip-neutral',
  client: 'chip-neutral',
  dropped: 'chip-warn',
};

export default async function ArrivalsPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.manage')) redirect('/crm');
  const t = await getTranslations('crm');
  const rows = await recentIntakes(100);

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-4xl">
      <PageHeader icon="target" title={t('arrivals')} />

      {rows.length === 0 ? (
        <p className="card text-sm text-ink-500">{t('arrivalsEmpty')}</p>
      ) : (
        // A LIST, not a table. Six columns needed 620 px and the phone showed
        // the first three — so «what became of it», the one thing this screen
        // exists to answer, was the part off the right-hand edge. The board
        // cards' vocabulary instead: identity and verdict on one line, every
        // small fact on the muted row under it (#578).
        <ul className="space-y-2" data-testid="arrivals-rows">
          {rows.map((row) => {
            // The card it became, when it became one. A dropped arrival has
            // nowhere to go, and saying so is the point of the row.
            const href = row.leadId
              ? `/crm/leads/${row.leadId}`
              : row.clientId
                ? `/admin/clients/${row.clientId}`
                : null;
            return (
              <li key={row.id} className="card space-y-0 p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">
                    {href ? (
                      <Link href={href} className="link">
                        {row.name ?? row.phone ?? '—'}
                      </Link>
                    ) : (
                      (row.name ?? row.phone ?? '—')
                    )}
                  </span>
                  <span className={`shrink-0 ${OUTCOME_CLASS[row.outcome] ?? 'chip-neutral'}`}>
                    {t(`arrivalsOutcome_${row.outcome}` as 'arrivalsOutcome_created')}
                  </span>
                </div>
                <MetaLine
                  parts={[
                    `${row.createdAt.toLocaleDateString('ru-RU')} ${row.createdAt.toLocaleTimeString(
                      'ru-RU',
                      { hour: '2-digit', minute: '2-digit' },
                    )}`,
                    row.sourceKey,
                    row.channel,
                    row.phone,
                    row.ownerName,
                    row.reason,
                  ]}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
