import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { getSetting } from '@/modules/platform/settings/service';
import { salesManagerOptions } from '@/modules/platform/rbac/queries';
import { createClientAction } from '../actions';
import { ClientForm } from '../client-form';

export default async function NewClientPage() {
  // Its own gate: the /admin section gate is cosmetic and admits anyone
  // holding clients.view_own or crm.leads — every sales manager.
  const actor = await getActor();
  if (!actor?.permissions.has('clients.manage')) redirect('/');
  const t = await getTranslations('clients');
  const managers = await salesManagerOptions();
  const codePrefix = await getSetting('client_code_prefix');

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('new')}</h1>
      <ClientForm action={createClientAction} managers={managers} codePrefix={codePrefix} />
    </div>
  );
}
