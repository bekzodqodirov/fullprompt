import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { canReadTg, listConversations, tgViewerFor } from '@/modules/wms/crm/conversations';
import { pendingCount } from '@/modules/wms/crm/chat-rules';
import { mayDecideChats } from '@/modules/wms/crm/telegram-accounts';
import { PageHeader } from '@/components/ui/page';
import { TelegramBridgeStatus } from '@/components/telegram-bridge-status';

/**
 * Who has been talking to us — phase 2 of the client chat in the CRM.
 *
 * The client card answers "what did we say to THIS client". This answers the
 * question a sales manager actually starts the day with: who wrote, and who
 * is still waiting for an answer.
 *
 * Sorted by most recent, with the ones where the CLIENT spoke last marked.
 * That mark is the whole point of the screen — an unanswered customer is the
 * one thing on it that costs money.
 */
export const dynamic = 'force-dynamic';

function ago(date: Date, t: (k: string, v?: Record<string, unknown>) => string): string {
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 60) return t('minsAgo', { n: Math.max(mins, 1) });
  if (mins < 60 * 24) return t('hoursAgo', { n: Math.round(mins / 60) });
  // The office's calendar, not the server's: a message at 01:00 Tashkent is
  // yesterday in UTC, and the list would date it a day early (R5's rule).
  return date.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    timeZone: 'Asia/Tashkent',
  });
}

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  // Own gate, not the layout's (#198). Reading a client's conversation is
  // reading what they told us in confidence.
  // CRM grants or the supervision view (round 33: vedchi/admin read all).
  if (!canReadTg(actor)) {
    redirect('/');
  }
  const t = await getTranslations('crm');
  const tl = await getTranslations('lidChat');
  const { q } = await searchParams;
  // Own account only — except the owner's supervision view: as super_admin
  // he reads the whole company's threads, each row naming its manager
  // (his instruction, round 21: «rahbar sifatida hamma yozishmalar korinsin»).
  // A prospect's chat is a row here too (owner's 4a) — for whoever may open
  // lead cards at all; everyone else keeps the list they had.
  const rows = await listConversations(tgViewerFor(actor), q, undefined, { leadsFor: actor });

  // The tray's door is the manager's own connected account (or the
  // administrator's clients.manage — round 93); a manager counts only their
  // OWN waiting chats and the owner counts everybody's.
  const canDecide = await mayDecideChats(actor);
  const waiting = canDecide
    ? await pendingCount(actor.permissions.has('admin.settings.manage') ? undefined : actor.id)
    : 0;

  return (
    <div className="space-y-3">
      <PageHeader
        title={`✈️ ${t('conversations')}`}
        actions={
          <>
            {/* The sentences typed twenty times a day. Same gate as this
                screen — whoever may answer a client may keep their own. */}
            <Link
              href="/suhbatlar/shablonlar"
              className="btn-secondary"
              data-testid="templates-link"
            >
              ⚡ {t('templates')}
            </Link>
            {/* Their own account, connected from the screen (round 21). The
                person allowed to read chats is the person who may hold one. */}
            <Link href="/suhbatlar/ulash" className="btn-secondary" data-testid="connect-link">
              {t('connectTitle')}
            </Link>
          </>
        }
      />

      {/* Are messages actually arriving? The list growing is the only other
          evidence, and "nobody wrote today" looks identical to a dead bridge. */}
      <TelegramBridgeStatus />

      {/* Offered to whoever may decide, ALWAYS. It used to appear only while
          something was waiting, on the reasoning that an empty link is an
          invitation to an empty screen — and that reasoning was wrong: the
          screen also holds every chat already decided, with the button that
          takes one back out and the one that deletes what was stored from it.
          Answer the last pending chat and the only door to all of that
          vanished, which is exactly how the owner reported it («chatda
          qo'shilishi kerak bo'lmagan chatlarni olib tashlash degan joyi yo'q
          bo'lib qolibdi»). The BADGE is what depends on there being work. */}
      {canDecide && (
        <Link
          href="/suhbatlar/qaysi"
          className="card flex items-center justify-between !py-2.5 text-sm font-semibold"
          data-testid="which-chats-link"
        >
          <span>✈️ {t('whichChats')}</span>
          {waiting > 0 && (
            <span
              data-testid="which-chats-badge"
              className="rounded-full bg-warn/15 px-2 text-warn"
            >
              {t('whichChatsPendingBadge', { n: waiting })}
            </span>
          )}
        </Link>
      )}

      <form className="card !p-2">
        <input
          type="search"
          name="q"
          defaultValue={q ?? ''}
          placeholder={t('conversationsSearch')}
          className="input"
          data-testid="conversation-search"
        />
      </form>

      {rows.length === 0 ? (
        <p className="card text-center text-sm text-ink-500" data-testid="conversations-empty">
          {t('conversationsEmpty')}
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => {
            // The row's content is the same whichever kind it is; only the
            // way it opens differs. A lead row the reader may not open is
            // drawn WITHOUT a link — never with one that bounces off the lead
            // card's door (the design judge's first finding) — and names
            // whose lead it is, because that person can open it.
            const body = (
              <>
              <span
                className="font-mono text-sm font-extrabold text-brand-700"
                {...(row.kind === 'lead'
                  ? { title: tl('markTitle'), 'aria-label': tl('markTitle') }
                  : {})}
              >
                {/* A prospect has no GS code yet, so the slot says what the
                    person IS — «Lid», never «Yangi lid»: a lead chat can be
                    months old, and «new» already means «unread» on this very
                    row (the design judge's eleventh finding). */}
                {row.kind === 'lead' ? tl('mark') : row.code}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">
                  {row.name}
                  {/* Supervision view only: whose Telegram this thread lives on. */}
                  {row.managers.length > 0 && (
                    <span className="ml-1.5 text-xs font-normal text-ink-500">
                      · {row.managers.join(', ')}
                    </span>
                  )}
                </span>
                {row.kind === 'lead' && !row.href && (
                  <span
                    className="block truncate text-xs text-ink-500"
                    data-testid="conversation-lead-owner"
                  >
                    {row.leadOwner ? tl('owner', { name: row.leadOwner }) : tl('ownerNone')}
                  </span>
                )}
                <span className="block truncate text-sm text-ink-500">
                  {row.lastBody ?? `📎 ${t('telegramMedia')}`}
                </span>
              </span>
              <span className="shrink-0 text-right">
                {/* The client wrote and NOBODY has opened it — the alarm.
                    A chat the manager has already read says so quietly
                    instead, because «ok» needs nothing from anybody and a
                    red badge over it is the thing the owner called out. */}
                {row.state === 'new' && (
                  <span
                    className="mb-0.5 block rounded-full bg-warn/15 px-2 text-xs font-bold text-warn"
                    data-testid="waiting-on-us"
                  >
                    {t('waitingOnUs')}
                  </span>
                )}
                {/* The word costs 71 px of the client's NAME at 360, measured
                    — and this row is the one nobody has to act on, so it must
                    not be the one that truncates the name. Below `sm` the
                    tick carries it alone, the way «Yuborish» becomes ➤ in the
                    composer (#522); the word is still there for a reader who
                    asks. */}
                {row.state === 'seen' && (
                  <span
                    className="mb-0.5 block text-xs text-ink-500"
                    data-testid="chat-seen"
                    title={t('chatSeen')}
                    aria-label={t('chatSeen')}
                  >
                    ✓<span className="hidden sm:inline"> {t('chatSeen')}</span>
                  </span>
                )}
                <span className="block whitespace-nowrap text-xs text-ink-500">
                  {ago(row.lastAt, t as never)}
                </span>
              </span>
              </>
            );
            // `data-kind` is an API for the e2e suite: CI's one database can
            // hold lead chats other files left behind, and a spec that clicks
            // the FIRST row must say which kind it means (#653).
            const key = `${row.kind}:${row.clientId ?? row.leadId}`;
            return row.href ? (
              <Link
                key={key}
                href={row.href}
                className="card flex items-baseline gap-2 !py-2.5"
                data-testid="conversation-row"
                data-kind={row.kind}
              >
                {body}
              </Link>
            ) : (
              <div
                key={key}
                className="card flex items-baseline gap-2 !py-2.5"
                data-testid="conversation-row"
                data-kind={row.kind}
              >
                {body}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
