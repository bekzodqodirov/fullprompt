import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader, Section } from '@/components/ui/page';
import { Panel } from '@/components/panel';
import {
  listCustomEntities,
  recordCounts,
  writeChoiceOf,
} from '@/modules/platform/entities/service';
import { EntityForm, EntityToggle } from './entity-form';

/**
 * «Hech qanday biznes-obyekt hard-coded bo'lmasin» (#174) reaches its last
 * stop: the owner invents an OBJECT here — a name and a who-may-edit choice
 * — and it immediately has a list at /o, a card, custom fields, tasks and
 * history. Deactivated, never deleted: answers and tasks hang off it.
 */
export default async function EntitiesAdminPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('admin.dictionaries.manage')) redirect('/');

  const t = await getTranslations('objects');
  const [entities, counts] = await Promise.all([listCustomEntities(true), recordCounts()]);

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <PageHeader
        icon="boxes"
        back={{ href: '/admin', label: t('backToAdmin') }}
        title={t('adminTitle')}
      />
      <p className="text-sm text-ink-500">{t('adminIntro')}</p>

      <Panel title={`➕ ${t('newType')}`} testId="new-entity-panel" open={entities.length === 0}>
        <EntityForm />
      </Panel>

      <Section title={t('typesTitle')}>
        {entities.length === 0 && (
          <p className="card text-center text-sm text-ink-500">{t('noTypes')}</p>
        )}
        {entities.map((entity) => (
          <div key={entity.code} className="card space-y-2 !p-3" data-testid="entity-row">
            <div className="flex items-center justify-between gap-2">
              <Link
                href={`/o/${entity.code}`}
                className={`font-bold hover:underline ${entity.active ? '' : 'text-ink-400 line-through'}`}
              >
                {entity.label ?? entity.code}
              </Link>
              <div className="flex shrink-0 items-center gap-2">
                <span className="num text-xs text-ink-500">
                  {counts.get(entity.code) ?? 0} · {t(`choice.${writeChoiceOf(Array.isArray(entity.writePermissions) ? (entity.writePermissions as string[]) : [])}` as 'choice.everyone')}
                </span>
                <EntityToggle code={entity.code} active={entity.active} />
              </div>
            </div>
            <Panel title={`✏️ ${t('rename')}`} testId={`entity-edit-${entity.code}`}>
              <EntityForm
                code={entity.code}
                label={entity.label ?? entity.code}
                writeChoice={writeChoiceOf(
                  Array.isArray(entity.writePermissions)
                    ? (entity.writePermissions as string[])
                    : [],
                )}
              />
            </Panel>
            <p className="text-xs text-ink-500">
              <Link href="/admin/fields" className="text-good hover:underline">
                {t('addFieldsHint')}
              </Link>
            </p>
          </div>
        ))}
      </Section>
    </div>
  );
}
