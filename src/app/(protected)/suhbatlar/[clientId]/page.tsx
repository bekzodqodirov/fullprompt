import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import {
  codesSharingPhones,
  conversationClient,
  conversationFor,
  tgViewerFor,
} from '@/modules/wms/crm/conversations';
import { pendingFor } from '@/modules/wms/crm/outbox';
import { AutoRefresh } from '@/components/auto-refresh';
import { TelegramBubble } from '@/components/telegram-bubble';
import { TelegramReply } from '@/components/telegram-reply';

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
 * Replying is phase 4 and lives at the bottom — but only when a reply can
 * really go out. Everything about when that is true is in `telegram-send.ts`;
 * this screen asks and then either shows the box or says why not.
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
  const viewer = tgViewerFor(actor);
  const [client, messages, queued, codes] = await Promise.all([
    conversationClient(clientId),
    conversationFor(clientId, viewer),
    pendingFor(clientId, viewer),
    codesSharingPhones(clientId),
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
          {/* One person, several codes on one number — ALL of them (round 25). */}
          <span className="font-mono text-brand-700" data-testid="thread-codes">
            {(codes.length > 0 ? codes : [client.clientCode]).join(' · ')}
          </span>{' '}
          {client.name}
        </h1>
        {/* Straight to the cargo, the balance and the deals. */}
        <Link href={`/admin/clients/${client.id}`} className="btn-secondary !py-1 text-sm">
          {t('openCard')}
        </Link>
      </div>

      {messages.length === 0 && queued.length === 0 ? (
        <p className="card text-center text-sm text-ink-500">{t('conversationsEmpty')}</p>
      ) : (
        // `min-h-0` is what lets it shrink: a flex item will not go below its
        // content height without it, and the box would grow past the screen.
        <div
          className="card flex min-h-0 flex-1 flex-col-reverse gap-1.5 overflow-y-auto"
          data-testid="conversation-thread"
        >
          {/* Not yet sent, so BELOW the newest real message in reading order —
              which in a reversed box means first. Drawn differently on
              purpose: a queued reply is not a delivered one, and a client
              waiting on an answer nobody sent is the worst thing this feature
              can produce. */}
          {[...queued].reverse().map((row) => (
            <div
              key={row.id}
              className={`ml-auto max-w-[85%] rounded-xl border border-dashed px-3 py-2 text-sm ${
                row.status === 'failed' ? 'border-bad text-bad' : 'border-line-strong text-ink-500'
              }`}
              data-testid={`outbox-${row.status}`}
            >
              <div className="mb-0.5 text-xs font-semibold">
                {row.status === 'failed' ? `✕ ${t('replyFailed')}` : `◷ ${t('replyQueued')}`}
              </div>
              <p className="whitespace-pre-wrap break-words">
                {row.attachmentId && '🖼 '}
                {row.body}
              </p>
              {row.lastError && <p className="mt-1 text-xs">{row.lastError}</p>}
            </div>
          ))}

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

      {/* Shows the box, or says why it cannot. Same component as on the cards,
          so the two can never drift apart on who may speak. */}
      <TelegramReply clientId={clientId} />

      {/* A sent reply must stop reading «navbatda», and a client's new
          message must appear, without anybody pulling to refresh. */}
      <AutoRefresh ms={10_000} />
    </div>
  );
}
