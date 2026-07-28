import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { conversationClient, conversationFor } from '@/modules/wms/crm/conversations';
import { TelegramBubble } from '@/components/telegram-bubble';

/**
 * One client's conversation, read the way it happened — and opened where it
 * left off.
 *
 * A fixed-height box in `flex-col-reverse`, so the newest message is at the
 * bottom and the first painted frame is already there: scrolling up is
 * history, exactly as in Telegram itself. The owner's report was that opening
 * a chat from the list dropped him at the beginning of a year of messages
 * ("focus bugunga qaratilmagan"), which is true of any long thread rendered
 * top-down.
 *
 * The height is spelled out from the shell rather than guessed, because a box
 * that is one nav bar too tall hides the newest message under the tab bar —
 * which looks exactly like the bug it was meant to fix. The terms are the
 * layout's own: header `h-14` (3.5rem) + `main` `p-4` top (1rem) + the bottom
 * padding that clears the tab bar (`pb-28` = 7rem on a phone, `md:pb-8` = 2rem
 * on a desktop).
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
    // Capped and centred: on a wide screen an 85 % bubble against each edge
    // reads as two columns of unrelated text rather than as one conversation.
    <div className="mx-auto flex h-[calc(100dvh-11.5rem)] w-full max-w-3xl flex-col gap-3 md:h-[calc(100dvh-6.5rem)]">
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
        // `min-h-0` is what lets it shrink: a flex item will not go below its
        // content height without it, and the box would grow past the screen.
        <div
          className="card flex min-h-0 flex-1 flex-col-reverse gap-1.5 overflow-y-auto"
          data-testid="conversation-thread"
        >
          {messages.map((msg) => (
            <TelegramBubble
              key={msg.id}
              message={msg}
              clientLabel={t('telegramClient')}
              mediaLabel={t('telegramMedia')}
            />
          ))}
        </div>
      )}
    </div>
  );
}
