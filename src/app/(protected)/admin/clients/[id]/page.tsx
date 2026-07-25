import { desc, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { clients, clientTelegramLinks } from '@/modules/platform/db/schema';
import { getSetting } from '@/modules/platform/settings/service';
import { getBotUsername } from '@/modules/platform/telegram/bot';
import { HistoryTab } from '@/components/history-tab';
import { salesManagerOptions } from '@/modules/platform/rbac/queries';
import { toggleClientActiveAction, updateClientAction } from '../actions';
import { createClientCabinetCodeAction, revokeClientCabinetLinkAction } from '../cabinet-actions';
import { ClientForm } from '../client-form';
import { ClientCrmSections } from '../../../crm/client-crm';

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await db.query.clients.findFirst({ where: eq(clients.id, id) });
  if (!client) notFound();

  const tc = await getTranslations('common');
  const tcab = await getTranslations('clients');
  const format = await getFormatter();
  const managers = await salesManagerOptions();
  const codePrefix = await getSetting('client_code_prefix');
  const cabinetLinks = await db
    .select()
    .from(clientTelegramLinks)
    .where(eq(clientTelegramLinks.clientId, id))
    .orderBy(desc(clientTelegramLinks.createdAt))
    .then((rows) => rows.filter((r) => r.status !== 'revoked'));
  const botUsername = await getBotUsername();
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

      {/* Phase 2.2: Telegram cabinet — staff mints a one-time deep link and
          sends it to the client; the client sees cargo/photos/debt in the bot. */}
      <section className="card space-y-2">
        <h2 className="text-lg font-bold">🤖 {tcab('cabinetTitle')}</h2>
        <p className="text-xs text-gray-500">{tcab('cabinetHint')}</p>
        {cabinetLinks.map((link) => (
          <div key={link.id} className="flex flex-wrap items-center gap-2 border-b border-gray-100 pb-2 text-sm last:border-0">
            {link.status === 'linked' ? (
              <span className="font-semibold text-green-700">
                ✅ {tcab('cabinetLinked')}
                {link.linkedAt && ` · ${format.dateTime(new Date(link.linkedAt), { dateStyle: 'short' })}`}
              </span>
            ) : botUsername && link.linkCode ? (
              <>
                {/* The code label guards against sending another tab's link
                    to the wrong client (owner's incident). */}
                <span className="shrink-0 font-mono font-extrabold text-blue-800">
                  {client.clientCode}
                </span>
                <input
                  readOnly
                  className="input flex-1 font-mono text-xs"
                  value={`https://t.me/${botUsername}?start=${link.linkCode}`}
                />
              </>
            ) : (
              <span className="text-gray-500">{tcab('cabinetPending')}</span>
            )}
            <form action={revokeClientCabinetLinkAction}>
              <input type="hidden" name="linkId" value={link.id} />
              <button type="submit" className="text-xs font-semibold text-red-700 underline">
                ✖ {tcab('cabinetRevoke')}
              </button>
            </form>
          </div>
        ))}
        <form action={createClientCabinetCodeAction}>
          <input type="hidden" name="clientId" value={client.id} />
          <button type="submit" className="btn-secondary">
            🔗 {tcab('cabinetNewCode')}
          </button>
        </form>
      </section>

      {/* Phase 2.3: the sales side of the card — what was said, the owner's
          own fields, and the other codes the same person holds. */}
      <ClientCrmSections clientId={client.id} clientName={client.name} />

      <section>
        <h2 className="mb-2 text-lg font-bold">{tc('history')}</h2>
        <HistoryTab entityType="client" entityId={client.id} />
      </section>
    </div>
  );
}
