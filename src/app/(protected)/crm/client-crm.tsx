import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/panel';
import { getActor } from '@/modules/platform/rbac/authorize';
import { listActivities } from '@/modules/wms/crm/service';
import { fieldValues, listFields } from '@/modules/wms/crm/fields';
import { personForClient } from '@/modules/wms/crm/people';
import { ActivityForm } from './activity-form';
import { ClientFieldsForm } from './client-fields-form';
import { CustomFieldInputs } from './custom-fields';
import { MakePersonButton } from './make-person-button';

/**
 * The CRM half of a client card (owner's answer 7): what was said, the fields
 * he added himself, and the other codes the same human being holds.
 *
 * Rendered from the client page rather than duplicated there, so the sales
 * side of a client lives in one place whoever opens it.
 */
export async function ClientCrmSections({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const actor = await getActor();
  if (!actor?.permissions.has('crm.leads')) return null;
  const t = await getTranslations('crm');
  const tc = await getTranslations('common');

  const [log, fields, values, person] = await Promise.all([
    listActivities('client', clientId, 50),
    listFields('client'),
    fieldValues('client', clientId),
    personForClient(clientId),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const icon: Record<string, string> = { call: '📞', meeting: '🤝', message: '💬', note: '📝' };

  return (
    <div className="space-y-3">
      <ActivityForm entityType="client" entityId={clientId} today={today} />

      <Panel title={`🕘 ${t('history')}`} badge={log.length || undefined} open={log.length > 0}>
        {log.map(({ activity, authorName }) => (
          <div key={activity.id} className="border-b border-line pb-2 last:border-0 last:pb-0">
            <div className="flex items-baseline gap-2 text-xs text-ink-500">
              <span>{icon[activity.kind] ?? '📝'}</span>
              <span>{activity.happenedAt.toISOString().slice(0, 10)}</span>
              {authorName && <span className="ml-auto">{authorName}</span>}
            </div>
            <p className="text-sm [overflow-wrap:anywhere]">{activity.note}</p>
          </div>
        ))}
        {log.length === 0 && <p className="text-sm text-ink-500">{tc('empty')}</p>}
      </Panel>

      {fields.length > 0 && (
        <Panel title={`🧩 ${t('customFields')}`}>
          <ClientFieldsForm clientId={clientId}>
            <CustomFieldInputs fields={fields} values={values} />
          </ClientFieldsForm>
        </Panel>
      )}

      <Panel
        title={`👥 ${t('person')}`}
        badge={person ? `${person.codes.length} ${t('codes')}` : undefined}
      >
        {person ? (
          <>
            <p className="text-sm font-semibold">{person.person.name}</p>
            <div className="flex flex-wrap gap-1.5 text-sm">
              {person.codes.map((code) => (
                <Link
                  key={code.id}
                  href={`/admin/clients/${code.id}`}
                  className={`rounded px-1.5 py-0.5 font-mono font-bold ${
                    code.id === clientId ? 'bg-brand-600 text-white' : 'bg-brand-50 text-brand-700'
                  }`}
                >
                  {code.code}
                </Link>
              ))}
            </div>
            <p className="text-xs text-ink-500">{t('personNote')}</p>
          </>
        ) : actor.permissions.has('crm.manage') ? (
          <>
            <p className="text-xs text-ink-500">{t('personNote')}</p>
            <MakePersonButton clientId={clientId} clientName={clientName} />
          </>
        ) : (
          <p className="text-sm text-ink-500">{tc('empty')}</p>
        )}
      </Panel>
    </div>
  );
}
