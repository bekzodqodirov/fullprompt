import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { followUps, funnelReport, openLeadCount } from '@/modules/wms/crm/service';

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
      <div className="grid grid-cols-3 gap-2">
        <Link href="/crm/leads" className="card text-center">
          <div className="text-2xl font-extrabold text-blue-800">{openLeads}</div>
          <div className="text-xs text-gray-500">{t('leads')}</div>
        </Link>
        <div className="card text-center">
          <div className="text-2xl font-extrabold text-green-700">{won}</div>
          <div className="text-xs text-gray-500">{t('kindWon')}</div>
        </div>
        <div className="card text-center">
          <div className={`text-2xl font-extrabold ${due.length ? 'text-amber-600' : 'text-gray-400'}`}>
            {due.length}
          </div>
          <div className="text-xs text-gray-500">{t('today')}</div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">📞 {t('today')}</h1>
        <Link href="/crm/leads/new" className="btn-primary">
          + {t('newLead')}
        </Link>
      </div>

      {due.length === 0 ? (
        <p className="card text-sm text-gray-500">✅ {t('nothingToday')}</p>
      ) : (
        <div className="space-y-2">
          {due.map((item) => (
            <Link
              key={`${item.kind}-${item.id}`}
              href={item.kind === 'lead' ? `/crm/leads/${item.id}` : `/admin/clients/${item.id}`}
              className={`card block hover:bg-gray-50 ${
                item.dueOn < today ? 'border-l-4 border-l-amber-500' : ''
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span>{item.kind === 'lead' ? '🆕' : '👤'}</span>
                <span className="font-semibold">{item.title}</span>
                {item.subtitle && <span className="text-sm text-gray-500">{item.subtitle}</span>}
                <span
                  className={`ml-auto text-xs ${
                    item.dueOn < today ? 'font-bold text-amber-700' : 'text-gray-500'
                  }`}
                >
                  {item.dueOn < today ? `⚠️ ${item.dueOn}` : item.dueOn}
                </span>
              </div>
              {item.note && <p className="mt-1 text-sm text-gray-700">{item.note}</p>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
