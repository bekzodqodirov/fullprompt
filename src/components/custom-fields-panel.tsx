import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/panel';
import { getActor } from '@/modules/platform/rbac/authorize';
import { entitySpec } from '@/modules/platform/fields/registry';
import { customFieldsData } from '@/modules/platform/fields/view';
import { CustomFieldsForm } from './custom-fields-form';

/**
 * One card's custom fields — the whole feature, as a single line on a page.
 *
 * A server component so a card wires it up without learning anything about
 * fields: it names the object and the record, and gets a panel that is absent
 * when the owner has defined nothing for that object. An empty panel on nine
 * cards would be nine pieces of furniture nobody asked for.
 */
export async function CustomFieldsPanel({
  entityType,
  entityId,
  revalidate,
  open = false,
}: {
  entityType: string;
  entityId: string;
  /** Path to refresh after a save — the card's own route. */
  revalidate: string;
  open?: boolean;
}) {
  const spec = entitySpec(entityType);
  if (!spec) return null;

  const data = await customFieldsData(entityType, entityId);
  if (data.fields.length === 0) return null;

  const actor = await getActor();
  const editable = Boolean(
    actor && spec.writePermissions.some((code) => actor.permissions.has(code)),
  );
  const t = await getTranslations('fields');

  return (
    <Panel title={`🧩 ${t('title')}`} badge={data.fields.length} open={open} testId="custom-fields">
      <CustomFieldsForm
        entityType={entityType}
        entityId={entityId}
        revalidate={revalidate}
        editable={editable}
        {...data}
      />
    </Panel>
  );
}
