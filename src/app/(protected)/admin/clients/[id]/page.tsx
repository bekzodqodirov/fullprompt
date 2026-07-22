import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { clients } from '@/modules/platform/db/schema';
import { getSetting } from '@/modules/platform/settings/service';
import { HistoryTab } from '@/components/history-tab';
import { salesManagerOptions } from '@/modules/platform/rbac/queries';
import { toggleClientActiveAction, updateClientAction } from '../actions';
import { ClientForm } from '../client-form';

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await db.query.clients.findFirst({ where: eq(clients.id, id) });
  if (!client) notFound();

  const tc = await getTranslations('common');
  const managers = await salesManagerOptions();
  const codePrefix = await getSetting('client_code_prefix');
  const update = updateClientAction.bind(null, id);
  const toggle = toggleClientActiveAction.bind(null, id);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">
          <span className="font-mono text-blue-800">{client.clientCode}</span> — {client.name}
        </h1>
        <form action={toggle}>
          <button type="submit" className={client.active ? 'btn-danger' : 'btn-primary'}>
            {client.active ? tc('deactivate') : tc('activate')}
          </button>
        </form>
      </div>

      <ClientForm
        action={update}
        managers={managers}
        codePrefix={codePrefix}
        initial={{
          clientCode: client.clientCode,
          name: client.name,
          phones: (client.phones as string[]).join(', '),
          salesManagerId: client.salesManagerId ?? '',
          messengerNote: client.messengerNote ?? '',
          notes: client.notes ?? '',
        }}
      />

      <section>
        <h2 className="mb-2 text-lg font-bold">{tc('history')}</h2>
        <HistoryTab entityType="client" entityId={client.id} />
      </section>
    </div>
  );
}
