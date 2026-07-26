import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { Panel } from '@/components/panel';
import { PageHeader } from '@/components/ui/page';
import {
  ENTITY_SPECS,
  FIELDS_ADMIN_PERMISSION,
  LOOKUP_SPECS,
} from '@/modules/platform/fields/registry';
import { allFields, countFieldAnswers } from '@/modules/platform/fields/service';
import { options, rulesOf, showIfOf } from '@/modules/platform/fields/types';
import { FieldForm, type FieldRow } from './field-form';

/**
 * The owner decides what every card asks for (owner: "hech qanday
 * biznes-obyekt hard-coded bo'lmasin").
 *
 * This used to be a section of /crm/settings that could only reach leads and
 * clients. It is one screen for every object now, grouped by object, because
 * the question people arrive with is "what does a receipt ask for", not "show
 * me all fields".
 */
export default async function FieldsAdminPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has(FIELDS_ADMIN_PERMISSION)) redirect('/');

  const t = await getTranslations('fields');
  const fields = await allFields();

  const entities = ENTITY_SPECS.map((spec) => ({
    code: spec.code,
    label: t(`entities.${spec.labelKey}` as 'entities.client'),
  }));
  const lookupEntities = LOOKUP_SPECS.map((spec) => ({
    code: spec.code,
    label: t(`entities.${spec.labelKey}` as 'entities.client'),
  }));
  const siblings = fields.map((field) => ({
    id: field.id,
    label: field.label,
    entityType: field.entityType,
    type: field.type,
  }));

  const rows: FieldRow[] = await Promise.all(
    fields.map(async (field) => ({
      id: field.id,
      entityType: field.entityType,
      label: field.label,
      type: field.type,
      options: options(field),
      help: field.help,
      rules: rulesOf(field),
      showIf: showIfOf(field),
      required: field.required,
      onList: field.onList,
      lookupEntity: field.lookupEntity,
      sortOrder: field.sortOrder,
      active: field.active,
      answers: await countFieldAnswers(field.id),
    })),
  );

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-3xl">
      <PageHeader icon="clipboard" title={t('title')} />
      <p className="text-sm text-ink-500">{t('intro')}</p>

      <Panel title={`➕ ${t('newField')}`} testId="new-field-panel">
        <FieldForm entities={entities} lookupEntities={lookupEntities} siblings={siblings} />
      </Panel>

      {entities.map((entity) => {
        const mine = rows.filter((row) => row.entityType === entity.code);
        if (mine.length === 0) return null;
        return (
          <Panel
            key={entity.code}
            title={`🧩 ${entity.label}`}
            badge={mine.length}
            testId={`entity-${entity.code}`}
          >
            {mine.map((row) => (
              <FieldForm
                key={row.id}
                field={row}
                entities={entities}
                lookupEntities={lookupEntities}
                siblings={siblings}
              />
            ))}
          </Panel>
        );
      })}
    </div>
  );
}
