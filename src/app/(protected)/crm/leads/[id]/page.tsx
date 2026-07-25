import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { leads } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { salesManagerOptions } from '@/modules/platform/rbac/queries';
import { getSetting } from '@/modules/platform/settings/service';
import { Panel } from '@/components/panel';
import { listActivities, listSources, listStages } from '@/modules/wms/crm/service';
import { fieldValues, listFields } from '@/modules/wms/crm/fields';
import { convertLeadAction, updateLeadAction } from '../../actions';
import { ActivityForm } from '../../activity-form';
import { CustomFieldInputs } from '../../custom-fields';
import { LeadForm } from '../lead-form';
import { ConvertForm } from './convert-form';
import { StageMover } from './stage-mover';

/** One lead: where it stands, what was said, and the button that ends it. */
export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.leads')) redirect('/');
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!lead) notFound();
  // A sales manager works their own leads; seeing someone else's would let
  // two people call the same person about the same cargo.
  if (!actor.permissions.has('crm.leads.view_all') && lead.ownerId !== actor.id) redirect('/crm');

  const t = await getTranslations('crm');
  const tc = await getTranslations('common');
  const [sources, stages, managers, fields, values, log, codePrefix] = await Promise.all([
    listSources(),
    listStages(),
    salesManagerOptions(),
    listFields('lead'),
    fieldValues('lead', id),
    listActivities('lead', id),
    getSetting('client_code_prefix'),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const update = updateLeadAction.bind(null, id);
  const convert = convertLeadAction.bind(null, id);
  const icon: Record<string, string> = { call: '📞', meeting: '🤝', message: '💬', note: '📝' };

  return (
    <div className="mx-auto max-w-lg space-y-3">
      <Link href="/crm/leads" className="text-sm font-semibold text-blue-800">
        ← {t('funnel')}
      </Link>
      <h1 className="text-xl font-bold [overflow-wrap:anywhere]">{lead.name}</h1>

      <StageMover
        leadId={id}
        currentId={lead.stageId}
        stages={stages.map((stage) => ({
          id: stage.id,
          name: stage.name,
          kind: stage.kind,
          color: stage.color,
        }))}
      />
      {lead.lostReason && (
        <p className="card !py-2 text-sm text-red-700">✖ {lead.lostReason}</p>
      )}

      {lead.clientId ? (
        <Link href={`/admin/clients/${lead.clientId}`} className="card block text-sm font-semibold text-green-700">
          ✅ {t('alreadyClient')} →
        </Link>
      ) : (
        // Open once the lead reaches a won stage: at that moment minting the
        // client card is the only thing left to do, and hiding it behind a
        // tap is how a won deal sits around without a code for a week.
        <Panel
          title={`🤝 ${t('convert')}`}
          open={stages.find((stage) => stage.id === lead.stageId)?.kind === 'won'}
        >
          <ConvertForm
            action={convert}
            defaultName={lead.company || lead.name}
            codePrefix={String(codePrefix)}
          />
        </Panel>
      )}

      <ActivityForm entityType="lead" entityId={id} today={today} />

      <div className="card space-y-2">
        <h2 className="text-sm font-bold uppercase text-gray-500">🕘 {t('history')}</h2>
        {log.map(({ activity, authorName }) => (
          <div key={activity.id} className="border-b border-gray-100 pb-2 last:border-0 last:pb-0">
            <div className="flex items-baseline gap-2 text-xs text-gray-500">
              <span>{icon[activity.kind] ?? '📝'}</span>
              <span>{activity.happenedAt.toISOString().slice(0, 10)}</span>
              {authorName && <span className="ml-auto">{authorName}</span>}
            </div>
            <p className="text-sm [overflow-wrap:anywhere]">{activity.note}</p>
          </div>
        ))}
        {log.length === 0 && <p className="text-sm text-gray-500">{tc('empty')}</p>}
      </div>

      <Panel title={`✏️ ${tc('edit')}`}>
        <LeadForm
          action={update}
          sources={sources.map((row) => ({ id: row.id, label: row.name }))}
          stages={stages.map((row) => ({ id: row.id, label: row.name }))}
          owners={managers.map((row) => ({ id: row.id, label: row.fullName }))}
          initial={{
            name: lead.name,
            phone: lead.phone ?? '',
            company: lead.company ?? '',
            sourceId: lead.sourceId ?? '',
            stageId: lead.stageId,
            ownerId: lead.ownerId ?? '',
            note: lead.note ?? '',
            nextActionAt: lead.nextActionAt ?? '',
            nextActionNote: lead.nextActionNote ?? '',
          }}
        >
          <CustomFieldInputs fields={fields} values={values} />
        </LeadForm>
      </Panel>
    </div>
  );
}
