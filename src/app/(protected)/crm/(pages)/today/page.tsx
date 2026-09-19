import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { funnelReport, openLeadCount } from '@/modules/wms/crm/service';
import { dayCalls } from '@/modules/wms/crm/day';
import { DayCallsView } from '@/components/day-calls-view';
import { Icon } from '@/components/ui/icon';
import { Stat } from '@/components/ui/page';

/**
 * The CRM home screen is the call list, not a dashboard.
 *
 * A sales manager opens this in the morning to find out who to ring; putting
 * charts here first would bury the only thing that has to happen today.
 */
export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<{ hammasi?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.leads')) redirect('/');
  const t = await getTranslations('crm');
  const seesAll = actor.permissions.has('crm.leads.view_all');
  const scope = seesAll ? undefined : actor.id;
  const showOthers = (await searchParams).hammasi === '1';

  const today = new Date().toISOString().slice(0, 10);
  const [calls, openLeads, funnel] = await Promise.all([
    // The SAME call list `/bugun` draws — mine by default, everybody's behind
    // a door, per seller (owner's 4.1a). This screen is where the seller's
    // home actually sends them, so the module has to be shared or the fix
    // only reaches one of the two screens carrying this title.
    dayCalls({ actorId: actor.id, seesAll, asOf: today, includeOthers: showOthers }),
    openLeadCount(scope),
    funnelReport(scope),
  ]);
  const due = [...calls.mine, ...calls.stale];
  const won = funnel.stages.filter((row) => row.kind === 'won').reduce((a, r) => a + r.n, 0);

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      {/* No page title here: the section tab strip above already says
          "today's calls", and repeating it wasted the first screenful. */}
      <div className="flex justify-end">
        <Link href="/crm/leads/new" className="btn-primary">
          <Icon name="plus" className="h-4 w-4" />
          {t('newLead')}
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-2.5">
        <Stat href="/crm" label={t('leads')} value={openLeads} tone="brand" />
        <Stat label={t('kindWon')} value={won} tone="good" />
        <Stat label={t('today')} value={due.length} tone={due.length ? 'warn' : 'neutral'} />
      </div>

      <DayCallsView calls={calls} basePath="/crm/today" showOthers={showOthers} />

    </div>
  );
}
