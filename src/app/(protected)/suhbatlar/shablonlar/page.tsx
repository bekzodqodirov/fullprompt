import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { canReadTg } from '@/modules/wms/crm/conversations';
import { SHARE_TEMPLATES_PERMISSION, listTemplates } from '@/modules/wms/crm/templates';
import { PageHeader } from '@/components/ui/page';
import { TemplateList } from './template-list';

/**
 * The canned replies, managed.
 *
 * Two lists in one screen on purpose: the company's, which an admin writes and
 * everybody is offered, and this person's own, which nobody else sees. Keeping
 * them apart on the page would hide the only thing a manager needs to know
 * about a row before editing it — whose it is — so the 🏢 mark carries that
 * and the rows sit in the order the composer will offer them.
 */
export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  // The composer's gate: whoever may answer a client may keep the sentences
  // they answer with. Publishing to the company is a second, narrower check
  // inside the service.
  if (!canReadTg(actor)) redirect('/');

  const t = await getTranslations('crm');
  const rows = await listTemplates(actor.id);

  return (
    <div className="mx-auto max-w-lg space-y-3">
      <PageHeader
        icon="settings"
        back={{ href: '/suhbatlar', label: t('conversations') }}
        title={`⚡ ${t('templatesTitle')}`}
      />
      <p className="text-sm text-ink-500" data-testid="template-hint">
        {t('templateHint')}
      </p>

      <TemplateList
        templates={rows.map((row) => ({
          id: row.id,
          title: row.title,
          body: row.body,
          sortOrder: row.sortOrder,
          shared: row.userId === null,
        }))}
        canShare={actor.permissions.has(SHARE_TEMPLATES_PERMISSION)}
      />
    </div>
  );
}
