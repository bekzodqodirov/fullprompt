import { desc, eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { clients, clientTelegramLinks } from '@/modules/platform/db/schema';
import { getSetting } from '@/modules/platform/settings/service';
import { getBotUsername } from '@/modules/platform/telegram/bot';
import { CardCols } from '@/components/card-cols';
import { CustomFieldsPanel } from '@/components/custom-fields-panel';
import { HistoryTab } from '@/components/history-tab';
import { CargoSummary } from '@/components/cargo-summary';
import { getActor } from '@/modules/platform/rbac/authorize';
import { salesManagerOptions } from '@/modules/platform/rbac/queries';
import { toggleClientActiveAction, updateClientAction } from '../actions';
import { createClientCabinetCodeAction, revokeClientCabinetLinkAction } from '../cabinet-actions';
import { ClientForm } from '../client-form';
import { ClientCrmSections } from '../../../crm/client-crm';
import { TasksPanel } from '@/components/tasks-panel';
import { ClientFeed } from '@/components/client-feed';
import { TelegramThread } from '@/components/telegram-thread';
import { CallsPanel } from '@/components/calls-panel';
import { ClientDeals } from '@/components/client-deals';

export default async function ClientDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `hodim` = whose Telegram conversation to read in the panel (2026-08-07). */
  searchParams: Promise<{ hodim?: string }>;
}) {
  const { id } = await params;
  const { hodim } = await searchParams;
  const actor = await getActor();
  if (!actor) redirect('/login');
  // Sales staff read the card their CRM sends them to; only an admin edits
  // it or mints a cabinet link.
  const canEdit = actor.permissions.has('clients.manage');
  if (!canEdit && !actor.permissions.has('clients.view_own') && !actor.permissions.has('crm.leads')) {
    redirect('/');
  }
  const client = await db.query.clients.findFirst({ where: eq(clients.id, id) });
  if (!client) notFound();

  const tc = await getTranslations('common');
  const tcab = await getTranslations('clients');
  const tcargo = await getTranslations('cargo');
  const format = await getFormatter();
  const canSeeMoney =
    actor.permissions.has('finance.view') || actor.permissions.has('finance.manage');
  // Only the admin half of the card needs these — a sales manager reading a
  // card should not cost a settings read and a call to Telegram.
  const managers = canEdit ? await salesManagerOptions(client.salesManagerId) : [];
  const codePrefix = canEdit ? await getSetting('client_code_prefix') : '';
  const cabinetLinks = canEdit
    ? await db
        .select()
        .from(clientTelegramLinks)
        .where(eq(clientTelegramLinks.clientId, id))
        .orderBy(desc(clientTelegramLinks.createdAt))
        .then((rows) => rows.filter((r) => r.status !== 'revoked'))
    : [];
  const botUsername = canEdit ? await getBotUsername() : null;
  const update = updateClientAction.bind(null, id);
  const toggle = toggleClientActiveAction.bind(null, id);

  return (
    <div className="space-y-6">
      {/* The dock opens straight into this client's conversation from here. */}
      <span data-dock-client={client.id} hidden />
      {/* flex-wrap + min-w-0: a long client name and the deactivate button
          must coexist on a 360 px screen instead of squeezing each other. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="min-w-0 text-xl font-bold [overflow-wrap:anywhere]">
          <span className="font-mono text-brand-700">{client.clientCode}</span> — {client.name}
        </h1>
        {canEdit && (
          <form action={toggle}>
            <button type="submit" className={client.active ? 'btn-danger' : 'btn-primary'}>
              {client.active ? tc('deactivate') : tc('activate')}
            </button>
          </form>
        )}
      </div>

      <CardCols
        main={
          <>
            {/* Owner: the card has to answer "where is this client's cargo
                and what do they owe" without a trip to two other screens. */}
            <section className="card space-y-2">
              <h2 className="text-lg font-bold">📦 {tcargo('title')}</h2>
              <CargoSummary clientId={client.id} money={canSeeMoney} />
            </section>

            {/* What was actually said, in the place it was actually said —
                the working surface of the card (owner: the amoCRM shape). */}
            <ClientFeed clientId={client.id} tall />
            <TelegramThread
              clientId={client.id}
              hodim={hodim}
              hrefFor={(who) =>
                who ? `/admin/clients/${client.id}?hodim=${who}` : `/admin/clients/${client.id}`
              }
            />
            <CallsPanel clientId={client.id} />
          </>
        }
        rail={
          <>
      {canEdit ? (
        <>
          {/* No read-only facts block on THIS card, unlike the lead's and the
              deal's: their ✏️ forms are folded, so a facts block is the only
              way to read a phone without opening an editor. This form is
              always open and shows the same fields — a block above it would
              print every value twice (2026-08-07, when the values stopped
              being editable in place and the duplication became visible). */}
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
        </>
      ) : (
        (client.phones as string[]).length > 0 && (
          <p className="card num text-sm">📞 {(client.phones as string[]).join(', ')}</p>
        )
      )}

      {/* Phase 2.2: Telegram cabinet — staff mints a one-time deep link and
          sends it to the client; the client sees cargo/photos/debt in the bot.
          Minting one is an admin job, so the whole panel is admin-only. */}
      {canEdit && (
      <section className="card space-y-2">
        <h2 className="text-lg font-bold">🤖 {tcab('cabinetTitle')}</h2>
        <p className="text-xs text-ink-500">{tcab('cabinetHint')}</p>
        {cabinetLinks.map((link) => (
          <div key={link.id} className="flex flex-wrap items-center gap-2 border-b border-line pb-2 text-sm last:border-0">
            {link.status === 'linked' ? (
              <span className="font-semibold text-good">
                ✅ {tcab('cabinetLinked')}
                {link.linkedAt && ` · ${format.dateTime(new Date(link.linkedAt), { dateStyle: 'short' })}`}
              </span>
            ) : botUsername && link.linkCode ? (
              <>
                {/* The code label guards against sending another tab's link
                    to the wrong client (owner's incident). */}
                <span className="shrink-0 font-mono font-extrabold text-brand-700">
                  {client.clientCode}
                </span>
                <input
                  readOnly
                  className="input flex-1 font-mono text-xs"
                  value={`https://t.me/${botUsername}?start=${link.linkCode}`}
                />
              </>
            ) : (
              <span className="text-ink-500">{tcab('cabinetPending')}</span>
            )}
            <form action={revokeClientCabinetLinkAction}>
              <input type="hidden" name="linkId" value={link.id} />
              <button type="submit" className="text-xs font-semibold text-bad underline">
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
      )}

      {/* The jobs we are doing for them, and which of those has gone wrong. */}
      <ClientDeals clientId={client.id} />

      {/* The fields the owner added to a client, whatever they are. */}
      <TasksPanel
        entityType="client"
        entityId={client.id}
        revalidate={`/admin/clients/${client.id}`}
      />

      <CustomFieldsPanel
        entityType="client"
        entityId={client.id}
        revalidate={`/admin/clients/${client.id}`}
      />

      {/* Phase 2.3: the sales side of the card — what was said and the other
          codes the same person holds. */}
      <ClientCrmSections clientId={client.id} clientName={client.name} />

      <section>
        <h2 className="mb-2 text-lg font-bold">{tc('history')}</h2>
        <HistoryTab entityType="client" entityId={client.id} />
      </section>
          </>
        }
      />
    </div>
  );
}
