'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/icon';
import { autogrow, sendOnEnter, useCoarsePointer } from '@/components/composer';
import { TelegramBubble } from '@/components/telegram-bubble';
import { entityHref } from '@/modules/platform/notifications/links';
import { sendReplyAction } from '@/modules/wms/crm/reply-actions';
import { completeTaskAction } from '@/modules/platform/tasks/actions';

/**
 * The dock — chat and tasks, reachable from ANY page (owner, items 5+7:
 * "hodimlar bilan gaplashish oynaning o'ng tarafida … chat butun sistemadan
 * kirsa bo'ladigan joyda, tasklar ixcham va har joydan reachable").
 *
 * One button in the app bar; a drawer from the right (from the bottom on a
 * phone, where "right" is not a direction the thumb has). Two tabs:
 *
 *  - 💬 conversations — the same list and thread as /suhbatlar, waiting-on-us
 *    marked, replies typed in place. On a client, deal or lead card the
 *    drawer opens straight into THAT card's conversation: the card declares
 *    it with a DOM marker (`data-dock-client`), which is how a client
 *    component learns what a server page was about without a second fetch.
 *  - ✅ my day — the same list as /bugun, one tap to finish.
 *
 * Everything here is fetched WHEN THE DRAWER OPENS, never on page load: the
 * dock rides on every page in the app, so its cost has to be zero until
 * somebody reaches for it. The chat tab exists only for people the
 * conversation gate lets in; everyone else gets a tasks-only dock.
 */

interface DockTask {
  id: string;
  title: string;
  dueAt: string | null;
  entityType: string | null;
  entityId: string | null;
}
interface DockConversation {
  clientId: string;
  clientCode: string;
  clientName: string;
  lastAt: string;
  lastBody: string | null;
  lastHasMedia: boolean;
  waitingOnUs: boolean;
}
interface DockThread {
  client: { id: string; code: string; name: string };
  canReply: boolean;
  reason: string | null;
  managers: string[];
  messages: {
    id: string;
    direction: string;
    body: string | null;
    hasMedia: boolean;
    sentAt: string;
    manager: string;
    photos: { id: string }[];
  }[];
}

export function Dock({ canChat }: { canChat: boolean }) {
  const pathname = usePathname();
  const t = useTranslations('crm');
  const tt = useTranslations('tasks');
  const tn = useTranslations('navShort');
  const tc = useTranslations('common');

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'chat' | 'tasks'>(canChat ? 'chat' : 'tasks');
  const [tasks, setTasks] = useState<{
    overdue: DockTask[];
    today: DockTask[];
    undated: DockTask[];
  } | null>(null);
  const [conversations, setConversations] = useState<DockConversation[] | null>(null);
  const [thread, setThread] = useState<DockThread | null>(null);
  const [threadFor, setThreadFor] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<{ id: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const coarse = useCoarsePointer();

  // Navigating away closes the drawer — it lives in the layout, which
  // survives navigation (the ••• sheet's lesson).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(false);
  }, [pathname]);

  const loadTasks = useCallback(async () => {
    const res = await fetch('/api/dock/tasks');
    if (res.ok) setTasks((await res.json()) as typeof tasks);
  }, []);

  const loadConversations = useCallback(async () => {
    const res = await fetch('/api/dock/conversations');
    if (res.ok)
      setConversations(
        ((await res.json()) as { conversations: DockConversation[] }).conversations,
      );
  }, []);

  const loadThread = useCallback(async (clientId: string) => {
    setThreadFor(clientId);
    setThread(null);
    setSendError(null);
    const res = await fetch(`/api/dock/thread?client=${clientId}`);
    if (res.ok) setThread((await res.json()) as DockThread);
  }, []);

  function openDock() {
    setOpen(true);
    void loadTasks();
    if (!canChat) {
      setTab('tasks');
      return;
    }
    // A card that is ABOUT a client opens straight into that conversation.
    const marker = document.querySelector<HTMLElement>('[data-dock-client]');
    const clientId = marker?.dataset.dockClient;
    if (clientId) {
      setTab('chat');
      void loadThread(clientId);
    } else {
      setThreadFor(null);
      setThread(null);
      void loadConversations();
    }
  }

  async function send() {
    // The id the SERVER resolved, not the marker the card put on the page:
    // one person often holds several GS codes on one phone and the chat
    // hangs off whichever one the import matched (round 32). Posting the
    // card's own code would be refused as «not your conversation» while the
    // thread above the box shows the very messages being answered.
    const target = thread?.client.id ?? threadFor;
    if (!target || (!body.trim() && !photo) || sending) return;
    setSending(true);
    setSendError(null);
    const form = new FormData();
    form.set('clientId', target);
    form.set('body', body);
    if (photo) form.set('attachmentId', photo.id);
    const result = await sendReplyAction({}, form);
    setSending(false);
    if (result.ok) {
      setBody('');
      setPhoto(null);
      void loadThread(target);
    } else {
      setSendError(result.error ?? 'error');
    }
  }

  // Same pre-binding as the thread composer: uploaded against a minted
  // tg_outbox group id; queueReply claims it onto the queue row.
  async function attachPhoto(list: FileList | null) {
    const file = list?.[0];
    if (!file) return;
    setUploading(true);
    const data = new FormData();
    data.set('file', file);
    data.set('entityType', 'tg_outbox');
    data.set('entityId', crypto.randomUUID());
    const res = await fetch('/api/files/upload', { method: 'POST', body: data });
    if (res.ok) {
      const { id } = (await res.json()) as { id: string };
      setPhoto({ id, name: file.name });
    }
    setUploading(false);
  }

  async function finishTask(id: string) {
    await completeTaskAction(id, pathname, {}, new FormData());
    void loadTasks();
  }

  const reasons: Record<string, string> = {
    no_chat: t('replyNoChat'),
    not_your_conversation: t('replyNotYours'),
    sending_disabled: t('replyDisabled'),
    never_wrote_first: t('replyNeverWrote'),
    bridge_down: t('replyBridgeDown'),
    rate_minute: t('replyRateLimited'),
    rate_day: t('replyRateLimited'),
    rate_chat: t('replyRateLimited'),
    flood_wait: t('replyRateLimited'),
  };

  const due = (tasks?.overdue.length ?? 0) + (tasks?.today.length ?? 0);

  return (
    <>
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openDock())}
        data-testid="dock-button"
        aria-label={`${t('conversations')} / ${tn('myDay')}`}
        className="btn-ghost btn-icon relative text-ink-700"
      >
        <Icon name="chat" />
      </button>

      {/* A portal, not a child: the app bar's backdrop-blur makes the header
          a containing block for fixed descendants, which pinned the "full
          screen" drawer inside a 56 px strip. The body has no such trap. */}
      {open &&
        createPortal(
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label={tc('back')}
            className="absolute inset-0 bg-ink-900/40"
            onClick={() => setOpen(false)}
          />
          <div
            data-testid="dock-panel"
            className="pb-safe absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl bg-surface-raised shadow-pop md:inset-x-auto md:inset-y-0 md:right-0 md:max-h-none md:w-[26rem] md:rounded-none"
          >
            {/* The same handle the ••• sheet wears, so the two bottom sheets
                read as one control. Phone only — the desktop drawer is not
                a sheet. */}
            <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line-strong md:hidden" />
            <div className="flex items-center gap-1 border-b border-line p-2">
              {canChat && (
                <button
                  type="button"
                  data-testid="dock-tab-chat"
                  onClick={() => {
                    setTab('chat');
                    if (!threadFor && !conversations) void loadConversations();
                  }}
                  className={`rounded-xl px-3 py-2 text-sm font-bold ${
                    tab === 'chat' ? 'bg-brand-50 text-brand-800' : 'text-ink-500'
                  }`}
                >
                  💬 {t('conversations')}
                </button>
              )}
              <button
                type="button"
                data-testid="dock-tab-tasks"
                onClick={() => setTab('tasks')}
                className={`rounded-xl px-3 py-2 text-sm font-bold ${
                  tab === 'tasks' ? 'bg-brand-50 text-brand-800' : 'text-ink-500'
                }`}
              >
                ✅ {tn('myDay')}
                {due > 0 && (
                  <span className="num ml-1.5 rounded-full bg-warn/15 px-1.5 text-xs text-warn">
                    {due}
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-label={tc('back')}
                onClick={() => setOpen(false)}
                className="btn-ghost btn-icon ml-auto text-ink-500"
              >
                <Icon name="x" />
              </button>
            </div>

            {tab === 'chat' && canChat && (
              <div className="flex min-h-0 flex-1 flex-col">
                {threadFor && thread ? (
                  <>
                    <div className="flex items-baseline gap-2 border-b border-line px-3 py-2">
                      <button
                        type="button"
                        aria-label={tc('back')}
                        data-testid="dock-thread-back"
                        onClick={() => {
                          setThreadFor(null);
                          setThread(null);
                          void loadConversations();
                        }}
                        className="font-bold text-brand-700"
                      >
                        ←
                      </button>
                      <Link
                        href={`/admin/clients/${thread.client.id}`}
                        className="min-w-0 truncate text-sm font-bold"
                        data-testid="dock-thread-client"
                      >
                        <span className="font-mono text-brand-700">{thread.client.code}</span>{' '}
                        {thread.client.name}
                      </Link>
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col-reverse gap-1.5 overflow-y-auto p-3">
                      {thread.messages.map((m) => (
                        <TelegramBubble
                          key={m.id}
                          message={{ ...m, sentAt: new Date(m.sentAt) }}
                          clientLabel={thread.client.name}
                          mediaLabel={t('telegramMedia')}
                        />
                      ))}
                      {thread.messages.length === 0 && (
                        <p className="text-center text-sm text-ink-500">
                          {t('conversationsEmpty')}
                        </p>
                      )}
                    </div>
                    <div className="border-t border-line p-2">
                      {thread.canReply ? (
                        <div className="space-y-1">
                          {photo && (
                            <div className="flex items-center gap-1.5">
                              <span className="max-w-48 truncate rounded-lg bg-surface-sunken px-2 py-1 text-xs font-semibold">
                                🖼 {photo.name}
                              </span>
                              <button
                                type="button"
                                aria-label="✕"
                                onClick={() => setPhoto(null)}
                                className="btn-ghost btn-icon !min-h-7 text-xs"
                              >
                                ✕
                              </button>
                            </div>
                          )}
                          <div className="flex items-end gap-2">
                          <label
                            className={`btn-secondary btn-icon shrink-0 cursor-pointer ${
                              uploading || photo ? 'pointer-events-none opacity-50' : ''
                            }`}
                            aria-label={t('replyAttach')}
                            title={t('replyAttach')}
                            data-testid="dock-attach"
                          >
                            {uploading ? '…' : '📎'}
                            <input
                              type="file"
                              accept="image/*"
                              hidden
                              onChange={(event) => void attachPhoto(event.target.files)}
                            />
                          </label>
                          <textarea
                            value={body}
                            onChange={(event) => {
                              setBody(event.target.value);
                              autogrow(event.target);
                            }}
                            onKeyDown={(event) => sendOnEnter(event, coarse, () => void send())}
                            placeholder={t('replyPlaceholder')}
                            rows={1}
                            data-testid="dock-reply"
                            className="input max-h-28 min-w-0 flex-1 resize-none"
                          />
                          <button
                            type="button"
                            onClick={() => void send()}
                            disabled={sending || uploading || (!body.trim() && !photo)}
                            data-testid="dock-send"
                            className="btn-primary shrink-0 px-3 disabled:opacity-50"
                          >
                            {sending ? t('replySending') : t('replySend')}
                          </button>
                          </div>
                        </div>
                      ) : (
                        <p className="text-center text-xs text-ink-500">
                          {reasons[thread.reason ?? ''] ?? thread.reason}
                          {thread.reason === 'not_your_conversation' &&
                            thread.managers.length > 0 &&
                            ` · ${thread.managers.join(', ')}`}
                        </p>
                      )}
                      {sendError && (
                        <p className="mt-1 text-center text-xs font-semibold text-bad">
                          {reasons[sendError] ?? tc('error')}
                        </p>
                      )}
                    </div>
                  </>
                ) : threadFor ? (
                  <p className="p-4 text-center text-sm text-ink-500">{tc('loading')}</p>
                ) : (
                  <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    {conversations === null && (
                      <p className="p-2 text-center text-sm text-ink-500">{tc('loading')}</p>
                    )}
                    {conversations?.length === 0 && (
                      <p className="p-2 text-center text-sm text-ink-500">
                        {t('conversationsEmpty')}
                      </p>
                    )}
                    {conversations?.map((row) => (
                      <button
                        key={row.clientId}
                        type="button"
                        data-testid="dock-conversation"
                        onClick={() => void loadThread(row.clientId)}
                        className="flex w-full items-baseline gap-2 rounded-xl p-2.5 text-left hover:bg-surface-sunken"
                      >
                        <span className="shrink-0 font-mono text-sm font-extrabold text-brand-700">
                          {row.clientCode}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">
                            {row.clientName}
                          </span>
                          <span className="block truncate text-xs text-ink-500">
                            {row.lastBody ?? `📎 ${t('telegramMedia')}`}
                          </span>
                        </span>
                        {row.waitingOnUs && (
                          <span className="shrink-0 rounded-full bg-warn/15 px-2 py-0.5 text-xs font-bold text-warn">
                            {t('waitingOnUs')}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === 'tasks' && (
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
                {tasks === null && (
                  <p className="text-center text-sm text-ink-500">{tc('loading')}</p>
                )}
                {tasks && due === 0 && tasks.undated.length === 0 && (
                  <p className="text-center text-sm text-ink-500">{tt('allClear')}</p>
                )}
                {tasks && tasks.overdue.length > 0 && (
                  <TaskGroup
                    title={`🔴 ${tt('overdue')}`}
                    rows={tasks.overdue}
                    finishLabel={tt('finish')}
                    onFinish={finishTask}
                  />
                )}
                {tasks && tasks.today.length > 0 && (
                  <TaskGroup
                    title={`🟡 ${tt('dueToday')}`}
                    rows={tasks.today}
                    finishLabel={tt('finish')}
                    onFinish={finishTask}
                  />
                )}
                {tasks && tasks.undated.length > 0 && (
                  <TaskGroup
                    title={tt('noDeadline')}
                    rows={tasks.undated}
                    finishLabel={tt('finish')}
                    onFinish={finishTask}
                  />
                )}
                <Link
                  href="/bugun"
                  className="block text-center text-sm font-semibold text-brand-700"
                >
                  {tt('title')} →
                </Link>
              </div>
            )}
          </div>
        </div>,
          document.body,
        )}
    </>
  );
}

function TaskGroup({
  title,
  rows,
  finishLabel,
  onFinish,
}: {
  title: string;
  rows: DockTask[];
  finishLabel: string;
  onFinish: (id: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="section-title">{title}</p>
      {rows.map((task) => {
        const href = entityHref(task.entityType, task.entityId);
        return (
          <div key={task.id} data-testid="dock-task" className="flex items-center gap-2 rounded-xl bg-surface-sunken p-2.5">
            <span className="min-w-0 flex-1">
              {href ? (
                <Link href={href} className="block truncate text-sm font-semibold hover:underline">
                  {task.title}
                </Link>
              ) : (
                <span className="block truncate text-sm font-semibold">{task.title}</span>
              )}
              {task.dueAt && <span className="num text-xs text-ink-500">{task.dueAt}</span>}
            </span>
            <button
              type="button"
              onClick={() => onFinish(task.id)}
              className="btn-secondary !min-h-9 shrink-0 px-2 text-sm"
            >
              ✓ {finishLabel}
            </button>
          </div>
        );
      })}
    </div>
  );
}
