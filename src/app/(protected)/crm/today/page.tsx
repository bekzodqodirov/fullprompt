import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { followUps, funnelReport, openLeadCount } from '@/modules/wms/crm/service';
import { Icon } from '@/components/ui/icon';
import { EmptyState, Stat } from '@/components/ui/page';

/**
 * The CRM home screen is the call list, not a dashboard.
 *
 * A sales manager opens this in the morning to find out who to ring; putting
 * charts here first would bury the only thing that has to happen today.
 */
export default async function CrmPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.leads')) redirect('/');
  const t = await getTranslations('crm');
  const seesAll = actor.permissions.has('crm.leads.view_all');
  const scope = seesAll ? undefined : actor.id;

  const today = new Date().toISOString().slice(0, 10);
  const [due, openLeads, funnel] = await Promise.all([
    followUps(today, scope),
    openLeadCount(scope),
    funnelReport(scope),
  ]);
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

      {due.length === 0 ? (
        <EmptyState icon="check" title={t('nothingToday')} />
      ) : (
        <div className="space-y-2">
          {due.map((item) => (
            <Link
              key={`${item.kind}-${item.id}`}
              href={item.kind === 'lead' ? `/crm/leads/${item.id}` : `/admin/clients/${item.id}`}
              className={`card-tap block ${
                item.dueOn < today ? 'border-l-4 border-l-warn' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <Icon
                  name={item.kind === 'lead' ? 'target' : 'user'}
                  className="h-4 w-4 text-ink-400"
                />
                <span className="font-semibold">{item.title}</span>
                {item.subtitle && <span className="text-sm text-ink-500">{item.subtitle}</span>}
                <span
                  className={`ml-auto text-xs ${
                    item.dueOn < today ? 'font-bold text-warn' : 'text-ink-500'
                  }`}
                >
                  {item.dueOn < today ? `⚠️ ${item.dueOn}` : item.dueOn}
                </span>
              </div>
              {item.note && <p className="mt-1 text-sm text-ink-700">{item.note}</p>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
