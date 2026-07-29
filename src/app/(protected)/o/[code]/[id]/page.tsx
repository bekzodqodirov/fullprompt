import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader, Section } from '@/components/ui/page';
import { Panel } from '@/components/panel';
import { CustomFieldsPanel } from '@/components/custom-fields-panel';
import { TasksPanel } from '@/components/tasks-panel';
import { HistoryTab } from '@/components/history-tab';
import {
  canWriteEntity,
  recordById,
  resolveEntity,
} from '@/modules/platform/entities/service';
import { RecordForm } from './record-form';

/**
 * The GENERIC card #174 promised: name and note are the record's own, and
 * everything else it will ever carry is custom fields — plus the panels
 * every shipped card already has (tasks, history), which cost nothing
 * because they were generic from birth.
 */
export default async function CustomRecordPage({
  params,
}: {
  params: Promise<{ code: string; id: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const { code, id } = await params;
  const [entity, record] = await Promise.all([resolveEntity(code), recordById(id)]);
  if (!entity?.custom || !record || record.entityCode !== code) notFound();

  const t = await getTranslations('objects');
  const tc = await getTranslations('common');
  const writable = canWriteEntity(entity, actor.permissions);

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <PageHeader
        icon="boxes"
        back={{ href: `/o/${code}`, label: entity.label ?? code }}
        title={record.name}
        subtitle={!record.active ? <span className="text-bad">{t('inactive')}</span> : undefined}
      />

      {record.note && <p className="card whitespace-pre-wrap text-sm">{record.note}</p>}

      {writable && (
        <Panel title={`✏️ ${tc('edit')}`} testId="record-edit-panel">
          <RecordForm
            recordId={record.id}
            name={record.name}
            note={record.note}
            active={record.active}
          />
        </Panel>
      )}

      <CustomFieldsPanel
        entityType={code}
        entityId={record.id}
        revalidate={`/o/${code}/${record.id}`}
        open
      />

      <TasksPanel entityType={code} entityId={record.id} revalidate={`/o/${code}/${record.id}`} />

      <Section title={tc('history')}>
        <HistoryTab entityType={code} entityId={record.id} />
      </Section>
    </div>
  );
}
