import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { salesManagerOptions } from '@/modules/platform/rbac/queries';
import { listSources, listStages } from '@/modules/wms/crm/service';
import { leadFormStages } from '@/modules/wms/crm/stage-law';
import { blankFieldsData } from '@/modules/platform/fields/view';
import { createLeadAction } from '../../actions';
import { CustomFieldInputs } from '@/components/custom-fields';
import { LeadForm } from '../lead-form';
import { PageHeader } from '@/components/ui/page';

export default async function NewLeadPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.leads')) redirect('/');
  const t = await getTranslations('crm');

  const [sources, stages, managers, fields] = await Promise.all([
    listSources(),
    listStages(),
    salesManagerOptions(),
    blankFieldsData('lead'),
  ]);

  return (
    <div className="mx-auto max-w-lg space-y-3">
      <PageHeader icon="plus" title={t('newLead')} />
      {/* No lost stage on a CREATE form: a lead born lost has nobody's reason
          on it, and the service refuses that move anyway (round 83). */}
      <LeadForm
        action={createLeadAction}
        sources={sources.map((row) => ({ id: row.id, label: row.name }))}
        stages={leadFormStages(stages, null).map((row) => ({ id: row.id, label: row.name }))}
        owners={managers.map((row) => ({ id: row.id, label: row.fullName }))}
        initial={{
          name: '',
          phone: '',
          company: '',
          sourceId: '',
          stageId: stages[0]?.id ?? '',
          // The person entering a lead is usually the one who will work it.
          ownerId: actor.id,
          note: '',
          quotedAmount: '',
          quotedCurrency: '',
          quotedVolumeM3: '',
          quotedWeightKg: '',
          nextActionAt: '',
          nextActionNote: '',
        }}
      >
        <CustomFieldInputs {...fields} />
      </LeadForm>
    </div>
  );
}
