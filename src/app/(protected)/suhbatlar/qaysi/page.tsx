import Link from 'next/link';
import { redirect } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { clients } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { excludedLeftovers, listCandidates } from '@/modules/wms/crm/chat-rules';
import { mayDecideChats } from '@/modules/wms/crm/telegram-accounts';
import { PageHeader } from '@/components/ui/page';
import { ChatDecision } from './chat-decision';

/**
 * Which chats belong in the CRM — the owner's ask, answered by a person.
 *
 * The automatic rule (a phone number in the client book) stays and does most
 * of the work. This screen is for the two things it cannot know: a client
 * Telegram will not show a number for — 122 of them in the first real import,
 * because Telegram reveals a phone only to CONTACTS — and a chat it DOES match
 * that nobody wants kept.
 *
 * Two access rules, and they are the design rather than a detail:
 *
 *  - the door is `mayDecideChats`: the manager's OWN connected account, or
 *    `clients.manage` for the administrator. It was `clients.manage` alone
 *    for months (round 22's «deciding what the company keeps is not a sales
 *    job»), and the owner overruled it the day sellers connected: the tray
 *    filled with THEIR unknown chats on a screen only the admin could open
 *    («hodim o'zi tanlashi ... adminda chiqyapti, hodimda ko'rinmayapti»).
 *    The person whose account a chat sits in is exactly who knows whether it
 *    is a client, a lead or their cousin.
 *  - a manager sees only THEIR OWN chats. This list is the display names of
 *    the conversations the rule did not match, which for most managers is
 *    mostly their family and their friends. Only the owner
 *    (`admin.settings.manage`) sees everybody's, because somebody has to be
 *    able to finish the job.
 */
export const dynamic = 'force-dynamic';

export default async function WhichChatsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!(await mayDecideChats(actor))) redirect('/');

  const t = await getTranslations('crm');
  const { show } = await searchParams;
  const seeAll = actor.permissions.has('admin.settings.manage');

  const decision = show === 'done' ? undefined : ('pending' as const);
  const rows = (await listCandidates({
    managerUserId: seeAll ? undefined : actor.id,
    decision,
  })).filter((row) => (show === 'done' ? row.decision !== 'pending' : true));

  // What still stands behind each EXCLUDED chat, so the purge button can
  // carry its number and vanish once there is nothing left to delete.
  const leftovers = await excludedLeftovers(
    rows
      .filter((row) => row.decision === 'exclude')
      .map((row) => ({ id: row.id, managerUserId: row.managerUserId, peerId: BigInt(row.peerId) })),
  );

  // The client list for the picker. Active only: a chat is being attached to
  // somebody the company still works with, and a closed code is a wrong answer
  // that would be found much later.
  const book = await db
    .select({ id: clients.id, clientCode: clients.clientCode, name: clients.name })
    .from(clients)
    .where(eq(clients.active, true))
    .orderBy(asc(clients.clientCode));

  return (
    <div className="space-y-3">
      <PageHeader title={`✈️ ${t('whichChats')}`} />

      <p className="card text-sm text-ink-500">{t('whichChatsHint')}</p>

      <div className="flex gap-2">
        <Link
          href="/suhbatlar/qaysi"
          className={show === 'done' ? 'btn-secondary !min-h-9 flex-1' : 'btn-primary !min-h-9 flex-1'}
        >
          {t('whichChatsPending')}
        </Link>
        <Link
          href="/suhbatlar/qaysi?show=done"
          className={show === 'done' ? 'btn-primary !min-h-9 flex-1' : 'btn-secondary !min-h-9 flex-1'}
          data-testid="show-decided"
        >
          {t('whichChatsDecided')}
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="card text-center text-sm text-ink-500" data-testid="which-chats-empty">
          {show === 'done' ? t('whichChatsNoneDecided') : t('whichChatsNonePending')}
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <ChatDecision
              key={row.id}
              row={row}
              clients={book}
              showManager={seeAll}
              leftovers={leftovers.get(row.id) ?? 0}
              labels={{
                add: t('chatAdd'),
                never: t('chatNever'),
                undo: t('chatUndo'),
                cancel: t('chatCancel'),
                pickClient: t('chatPickClient'),
                findClient: t('chatFindClient'),
                save: t('chatSave'),
                included: t('chatIncluded'),
                excluded: t('chatExcluded'),
                noName: t('chatNoName'),
                purge: t('chatPurge'),
                purgeConfirm: t('chatPurgeConfirm'),
                openLead: t('chatOpenLead'),
                leadOpened: t('chatLeadOpened'),
              }}
            />
          ))}
        </div>
      )}

      <Link href="/suhbatlar" className="block text-center text-sm text-ink-500 underline">
        ← {t('conversations')}
      </Link>
    </div>
  );
}
