import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { conversationClient, conversationFor } from '@/modules/wms/crm/conversations';

/**
 * One client's conversation, read the way it happened.
 *
 * Oldest first here, unlike the panel on the client card: this screen is the
 * conversation itself, and a conversation is read forwards. The card's panel
 * is a reference — "what did we last say" — and is newest first for that
 * reason.
 *
 * Read-only in phase 2. Replying from here is phase 4, and until then the
 * screen must not pretend otherwise: there is no message box.
 */
export const dynamic = 'force-dynamic';

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.leads') && !actor.permissions.has('clients.manage')) {
    redirect('/');
  }
  const { clientId } = await params;
  const [client, messages] = await Promise.all([
    conversationClient(clientId),
    conversationFor(clientId),
  ]);
  if (!client) notFound();
  const t = await getTranslations('crm');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <Link href="/suhbatlar" className="text-sm text-ink-500 underline">
          ← {t('conversations')}
        </Link>
        <h1 className="flex-1 text-xl font-bold">
          <span className="font-mono text-brand-700">{client.clientCode}</span> {client.name}
        </h1>
        {/* Straight to the cargo, the balance and the deals. */}
        <Link href={`/admin/clients/${client.id}`} className="btn-secondary !py-1 text-sm">
          {t('openCard')}
        </Link>
      </div>

      {messages.length === 0 ? (
        <p className="card text-center text-sm text-ink-500">{t('conversationsEmpty')}</p>
      ) : (
        <div className="space-y-1.5" data-testid="conversation-thread">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                msg.direction === 'out' ? 'ml-auto bg-brand-50' : 'bg-surface-200'
              }`}
            >
              <div className="mb-0.5 flex justify-between gap-3 text-xs text-ink-500">
                <span>{msg.direction === 'out' ? msg.manager : t('telegramClient')}</span>
                <span className="whitespace-nowrap">
                  {new Date(msg.sentAt).toLocaleString('ru-RU', {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </span>
              </div>
              {msg.body ? (
                <p className="whitespace-pre-wrap break-words">{msg.body}</p>
              ) : (
                <p className="text-ink-500">📎 {t('telegramMedia')}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
