import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { Panel } from '@/components/panel';
import { listSources, listStages, stageUsage } from '@/modules/wms/crm/service';
import Link from 'next/link';
import { SourceForm, StageForm, StageTools } from './forms';
import { PageHeader } from '@/components/ui/page';

/**
 * Everything that makes the CRM the owner's rather than mine: the funnel, the
 * source list and the fields each card asks for.
 */
export default async function CrmSettingsPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.manage')) redirect('/crm');
  const t = await getTranslations('crm');

  const [stages, sources, usage] = await Promise.all([
    listStages(true),
    listSources(true),
    stageUsage(),
  ]);

  const stageRows = stages.map((stage) => ({
    id: stage.id,
    name: stage.name,
    kind: stage.kind,
    color: stage.color,
    sortOrder: stage.sortOrder,
    active: stage.active,
  }));

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-3xl">
      <PageHeader icon="settings" title={t('settings')} />

      <div className="card space-y-2">
        <h2 className="text-sm font-bold uppercase text-ink-500">🎯 {t('stages')}</h2>
        <StageTools stages={stageRows} usage={usage} />
      </div>

      <Panel title={`➕ ${t('addStage')}`}>
        <StageForm />
      </Panel>
      <Panel title={`✏️ ${t('stages')}`} badge={stageRows.length}>
        {stageRows.map((stage) => (
          <StageForm key={stage.id} stage={stage} />
        ))}
      </Panel>

      <Panel title={`➕ ${t('addSource')}`}>
        <SourceForm />
      </Panel>
      <Panel title={`📣 ${t('sources')}`} badge={sources.length}>
        {sources.map((source) => (
          <SourceForm
            key={source.id}
            source={{
              id: source.id,
              name: source.name,
              sortOrder: source.sortOrder,
              active: source.active,
            }}
          />
        ))}
      </Panel>

      {/* Fields moved out of the CRM: they are no longer a CRM feature, and
          two editors writing the same table is how one of them goes stale. */}
      <Link href="/admin/fields" className="card block hover:bg-surface-sunken">
        <span className="font-semibold">🧩 {t('fields')}</span>
        <span className="ml-2 text-sm text-ink-500">{t('fieldsMoved')}</span>
      </Link>
    </div>
  );
}
